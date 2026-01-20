import { Boom } from '@hapi/boom'
import NodeCache from '@cacheable/node-cache'
import crypto from 'crypto'
import P from 'pino'
import { createClient } from '@supabase/supabase-js'

import makeWASocket, {
	CacheStore,
	DEFAULT_CONNECTION_CONFIG,
	DisconnectReason,
	fetchLatestBaileysVersion,
	isJidNewsletter,
	jidNormalizedUser,
	makeCacheableSignalKeyStore,
	proto,
	useMultiFileAuthState,
} from '../src/index.js'

type ContactsMode = 'allowlist' | 'denylist'
type GroupDefaultRule = 'disabled' | 'enabled' | 'mentionOnly'
type AutomationRule = 'default' | 'enabled' | 'disabled' | 'mentionOnly'

type AppSettingsRow = {
	id: 1
	ignore_from_me: boolean
	contacts_mode: ContactsMode
	groups_default_rule: GroupDefaultRule
	reply_send_to: 'sameChat' | 'directToSender'
	reply_prefix: string
}

type EntityRuleRow = {
	jid: string
	type: 'contact' | 'group'
	name: string
	rule: AutomationRule
}

type RuntimeConfig = {
	settings: AppSettingsRow
	entityRules: {
		contacts: Map<string, EntityRuleRow>
		groups: Map<string, EntityRuleRow>
	}
}

type N8nWebhookPayload = {
	requestId: string
	receivedAt: string
	chatJid: string
	senderJid?: string
	isGroup: boolean
	messageId?: string
	messageTimestamp?: number
	text?: string
}

type N8nWebhookResponse = {
	replyText?: string
	sendTo?: 'sameChat' | 'directToSender'
	skipReply?: boolean
}

type MessageLogInsert = {
	direction: 'inbound' | 'outbound'
	chat_jid: string
	sender_jid?: string | null
	message_id?: string | null
	text?: string | null
	automated: boolean
	n8n_request_id?: string | null
	n8n_status?: number | null
	n8n_error?: string | null
}

const logger = P({
	level: process.env.LOG_LEVEL || 'info',
	transport: {
		targets: [
			{
				target: 'pino-pretty',
				options: { colorize: true },
				level: process.env.LOG_LEVEL || 'info',
			},
		],
	},
})

const msgRetryCounterCache = new NodeCache() as CacheStore

const env = (key: string, required = true) => {
	const v = (process.env[key] || '').trim()
	if (!v && required) throw new Error(`Missing env ${key}`)
	return v
}

const SUPABASE_URL = env('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = env('SUPABASE_SERVICE_ROLE_KEY')
const N8N_WEBHOOK_URL = env('N8N_WEBHOOK_URL')
const N8N_TIMEOUT_MS = Number(process.env.N8N_TIMEOUT_MS || '15000')
const N8N_SHARED_SECRET = (process.env.N8N_SHARED_SECRET || '').trim()

const AUTH_FOLDER = (process.env.AUTH_FOLDER || 'baileys_auth_info_bridge').trim()
const PAIRING_PHONE_NUMBER = (process.env.PAIRING_PHONE_NUMBER || '').trim()

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
	auth: { persistSession: false, autoRefreshToken: false },
})

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

const extractText = (msg: proto.IMessage | undefined | null): string | undefined => {
	if (!msg) return undefined
	if (msg.conversation) return msg.conversation
	if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text
	if (msg.imageMessage?.caption) return msg.imageMessage.caption
	if (msg.videoMessage?.caption) return msg.videoMessage.caption
	if (msg.documentMessage?.caption) return msg.documentMessage.caption
	return undefined
}

const isMentioningMe = (msg: proto.IMessage | undefined | null, myJid: string | undefined) => {
	if (!msg || !myJid) return false
	const my = jidNormalizedUser(myJid)
	const mentioned =
		msg.extendedTextMessage?.contextInfo?.mentionedJid ||
		msg.imageMessage?.contextInfo?.mentionedJid ||
		msg.videoMessage?.contextInfo?.mentionedJid ||
		msg.documentMessage?.contextInfo?.mentionedJid ||
		[]
	return mentioned.map(jidNormalizedUser).includes(my)
}

const callN8n = async (payload: N8nWebhookPayload): Promise<{ resp: N8nWebhookResponse; status: number }> => {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), N8N_TIMEOUT_MS || 15000)
	try {
		const res = await fetch(N8N_WEBHOOK_URL, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(N8N_SHARED_SECRET ? { 'x-bridge-secret': N8N_SHARED_SECRET } : {}),
			},
			body: JSON.stringify(payload),
			signal: controller.signal,
		})

		const status = res.status
		if (!res.ok) {
			const text = await res.text().catch(() => '')
			throw new Error(`n8n responded ${status}: ${text}`.slice(0, 800))
		}

		const json = (await res.json().catch(() => ({}))) as N8nWebhookResponse
		return { resp: json || {}, status }
	} finally {
		clearTimeout(timer)
	}
}

const insertLog = async (row: MessageLogInsert) => {
	const { error } = await supabase.from('message_logs').insert(row)
	if (error) {
		logger.warn({ error: error.message }, 'Failed to insert message log')
	}
}

const loadRuntimeConfig = async (): Promise<RuntimeConfig> => {
	const { data: settings, error: settingsErr } = await supabase
		.from('app_settings')
		.select('id,ignore_from_me,contacts_mode,groups_default_rule,reply_send_to,reply_prefix')
		.eq('id', 1)
		.single<AppSettingsRow>()

	if (settingsErr || !settings) {
		throw new Error(`Failed to load app_settings: ${settingsErr?.message || 'missing row'}`)
	}

	const { data: rules, error: rulesErr } = await supabase
		.from('entity_rules')
		.select('jid,type,name,rule')
		.returns<EntityRuleRow[]>()

	if (rulesErr) {
		throw new Error(`Failed to load entity_rules: ${rulesErr.message}`)
	}

	const contacts = new Map<string, EntityRuleRow>()
	const groups = new Map<string, EntityRuleRow>()

	for (const r of rules || []) {
		if (r.type === 'contact') contacts.set(r.jid, r)
		else groups.set(r.jid, r)
	}

	return { settings, entityRules: { contacts, groups } }
}

const resolveFinalGroupRule = (cfg: RuntimeConfig, chatJid: string, msg: proto.IMessage | undefined | null, myJid: string | undefined) => {
	const override = cfg.entityRules.groups.get(chatJid)
	const overrideRule = override?.rule && override.rule !== 'default' ? override.rule : undefined
	const base = cfg.settings.groups_default_rule
	const finalRule = (overrideRule || base) as GroupDefaultRule

	if (finalRule === 'disabled') return false
	if (finalRule === 'enabled') return true
	if (finalRule === 'mentionOnly') return isMentioningMe(msg, myJid)
	return false
}

const shouldAutomate = (cfg: RuntimeConfig, chatJid: string, isGroup: boolean, msg: proto.IMessage | undefined | null, myJid: string | undefined) => {
	if (isGroup) {
		return resolveFinalGroupRule(cfg, chatJid, msg, myJid)
	}

	// Direct chat
	const ruleRow = cfg.entityRules.contacts.get(chatJid)
	const override = ruleRow?.rule && ruleRow.rule !== 'default' ? ruleRow.rule : 'default'

	if (cfg.settings.contacts_mode === 'allowlist') {
		return override === 'enabled'
	}

	// denylist
	if (override === 'disabled') return false
	return true
}

const runtimeCache = {
	cfg: null as RuntimeConfig | null,
	loadedAt: 0,
	ttlMs: 4000,
}

const getRuntimeConfig = async () => {
	const now = Date.now()
	if (runtimeCache.cfg && now - runtimeCache.loadedAt < runtimeCache.ttlMs) return runtimeCache.cfg
	const cfg = await loadRuntimeConfig()
	runtimeCache.cfg = cfg
	runtimeCache.loadedAt = now
	return cfg
}

const start = async () => {
	const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER)
	const { version, isLatest } = await fetchLatestBaileysVersion()
	logger.info({ version, isLatest }, 'Using WhatsApp Web version')

	let pairingRequested = false

	const sock = makeWASocket({
		version,
		logger,
		waWebSocketUrl: process.env.SOCKET_URL ?? DEFAULT_CONNECTION_CONFIG.waWebSocketUrl,
		auth: {
			creds: state.creds,
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
		msgRetryCounterCache,
		generateHighQualityLinkPreview: false,
	})

	// Pairing code onboarding for headless environments
	if (!sock.authState.creds.registered) {
		if (PAIRING_PHONE_NUMBER && !pairingRequested) {
			pairingRequested = true
			await sleep(1500)
			const code = await sock.requestPairingCode(PAIRING_PHONE_NUMBER)
			logger.info({ code }, 'Pairing code')
		} else {
			logger.info('Not registered yet. Set PAIRING_PHONE_NUMBER to print a pairing code.')
		}
	}

	sock.ev.process(async (events) => {
		if (events['connection.update']) {
			const update = events['connection.update']
			const { connection, lastDisconnect } = update
			if (connection === 'close') {
				const code = (lastDisconnect?.error as Boom)?.output?.statusCode
				if (code !== DisconnectReason.loggedOut) {
					logger.warn({ code }, 'Connection closed; reconnecting')
					setTimeout(() => {
						start().catch(err => logger.error({ err }, 'Failed to restart'))
					}, 1500)
				} else {
					logger.error('Logged out. Delete auth folder and restart to re-pair.')
				}
			}
		}

		if (events['creds.update']) {
			await saveCreds()
		}

		if (!events['messages.upsert']) return

		const upsert = events['messages.upsert']
		if (upsert.type !== 'notify') return

		for (const m of upsert.messages) {
			const chatJid = m.key.remoteJid
			if (!chatJid) continue
			if (isJidNewsletter(chatJid)) continue

			const cfg = await getRuntimeConfig().catch(err => {
				logger.error({ err }, 'Failed to load runtime config')
				return null
			})
			if (!cfg) continue

			if (cfg.settings.ignore_from_me && m.key.fromMe) continue

			const isGroup = chatJid.endsWith('@g.us')
			const senderJid = isGroup ? m.key.participant || undefined : chatJid
			const text = extractText(m.message)

			const automated = shouldAutomate(cfg, chatJid, isGroup, m.message, sock.user?.id)

			if (text) {
				logger.info({ chatJid, senderJid, isGroup, automated }, 'Incoming message')
			}

			// Log inbound (even if not automated, as long as it has a text payload)
			if (text) {
				await insertLog({
					direction: 'inbound',
					chat_jid: chatJid,
					sender_jid: senderJid || null,
					message_id: m.key.id || null,
					text,
					automated,
				})
			}

			if (!automated) continue
			if (!text) continue

			const requestId = crypto.randomUUID()
			const payload: N8nWebhookPayload = {
				requestId,
				receivedAt: new Date().toISOString(),
				chatJid,
				senderJid,
				isGroup,
				messageId: m.key.id || undefined,
				messageTimestamp: typeof m.messageTimestamp === 'number' ? m.messageTimestamp : undefined,
				text,
			}

			try {
				logger.info({ chatJid, senderJid, requestId }, 'Forwarding message to n8n')

				const { resp, status } = await callN8n(payload)

				if (resp?.skipReply) {
					await insertLog({
						direction: 'outbound',
						chat_jid: chatJid,
						sender_jid: senderJid || null,
						message_id: null,
						text: null,
						automated: true,
						n8n_request_id: requestId,
						n8n_status: status,
						n8n_error: 'skipReply',
					})
					continue
				}

				const replyText = (resp?.replyText || '').trim()
				if (!replyText) {
					await insertLog({
						direction: 'outbound',
						chat_jid: chatJid,
						sender_jid: senderJid || null,
						message_id: null,
						text: null,
						automated: true,
						n8n_request_id: requestId,
						n8n_status: status,
					})
					continue
				}

				const sendTo = resp?.sendTo || cfg.settings.reply_send_to
				const finalText = `${cfg.settings.reply_prefix || ''}${replyText}`
				const destination = sendTo === 'directToSender' && senderJid ? senderJid : chatJid

				await sock.sendMessage(destination, { text: finalText })

				await insertLog({
					direction: 'outbound',
					chat_jid: destination,
					sender_jid: senderJid || null,
					message_id: null,
					text: finalText,
					automated: true,
					n8n_request_id: requestId,
					n8n_status: status,
				})

				logger.info({ destination, requestId }, 'Replied on WhatsApp')
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				await insertLog({
					direction: 'outbound',
					chat_jid: chatJid,
					sender_jid: senderJid || null,
					message_id: null,
					text: null,
					automated: true,
					n8n_request_id: requestId,
					n8n_status: null,
					n8n_error: msg.slice(0, 900),
				})
				logger.error({ err, chatJid, senderJid, requestId }, 'Failed to process message')
			}
		}
	})
}

await start()

