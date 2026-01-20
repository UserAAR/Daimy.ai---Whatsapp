import type { SupabaseClient } from '@supabase/supabase-js'

import { proto } from '../WAProto/index.js'
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from '../src/index.js'
import { BufferJSON, initAuthCreds } from '../src/index.js'

type CredsRow = {
	instance_id: string
	creds: unknown
}

type KeyRow = {
	instance_id: string
	type: string
	id: string
	data: unknown | null
}

const jsonEncode = (data: unknown) =>
	JSON.parse(JSON.stringify(data, BufferJSON.replacer)) as unknown

const jsonDecode = <T>(data: unknown): T =>
	JSON.parse(JSON.stringify(data), BufferJSON.reviver) as T

export async function useSupabaseAuthState(
	supabase: SupabaseClient,
	instanceId: string
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
	const loadCreds = async (): Promise<AuthenticationCreds> => {
		const { data, error } = await supabase
			.from('wa_auth_creds')
			.select('instance_id,creds')
			.eq('instance_id', instanceId)
			.maybeSingle<CredsRow>()

		if (error) throw new Error(`Failed to load wa_auth_creds: ${error.message}`)

		if (!data?.creds) {
			const creds = initAuthCreds()
			const { error: upsertErr } = await supabase
				.from('wa_auth_creds')
				.upsert({ instance_id: instanceId, creds: jsonEncode(creds) }, { onConflict: 'instance_id' })
			if (upsertErr) throw new Error(`Failed to init wa_auth_creds: ${upsertErr.message}`)
			return creds
		}

		return jsonDecode<AuthenticationCreds>(data.creds)
	}

	const creds = await loadCreds()

	const saveCreds = async () => {
		const { error } = await supabase
			.from('wa_auth_creds')
			.upsert({ instance_id: instanceId, creds: jsonEncode(creds) }, { onConflict: 'instance_id' })
		if (error) throw new Error(`Failed to save wa_auth_creds: ${error.message}`)
	}

	return {
		state: {
			creds,
			keys: {
				get: async (type, ids) => {
					const out: { [_: string]: SignalDataTypeMap[typeof type] } = {}
					if (!ids?.length) return out

					const { data, error } = await supabase
						.from('wa_auth_keys')
						.select('instance_id,type,id,data')
						.eq('instance_id', instanceId)
						.eq('type', type)
						.in('id', ids)
						.returns<KeyRow[]>()

					if (error) throw new Error(`Failed to load wa_auth_keys: ${error.message}`)

					const rows = data || []
					for (const id of ids) {
						const row = rows.find(r => r.id === id)
						let value = row?.data ? jsonDecode<any>(row.data) : null
						if (type === 'app-state-sync-key' && value) {
							value = proto.Message.AppStateSyncKeyData.fromObject(value)
						}
						out[id] = value
					}

					return out
				},
				set: async (data) => {
					const upserts: KeyRow[] = []
					const deletes: { type: string; id: string }[] = []

					for (const category in data) {
						for (const id in data[category as keyof SignalDataTypeMap]) {
							const value = data[category as keyof SignalDataTypeMap]![id]
							if (value) {
								upserts.push({
									instance_id: instanceId,
									type: category,
									id,
									data: jsonEncode(value),
								})
							} else {
								deletes.push({ type: category, id })
							}
						}
					}

					if (upserts.length) {
						const { error } = await supabase
							.from('wa_auth_keys')
							.upsert(upserts, { onConflict: 'instance_id,type,id' })
						if (error) throw new Error(`Failed to upsert wa_auth_keys: ${error.message}`)
					}

					// Delete one-by-one to keep logic simple and reliable
					for (const d of deletes) {
						const { error } = await supabase
							.from('wa_auth_keys')
							.delete()
							.eq('instance_id', instanceId)
							.eq('type', d.type)
							.eq('id', d.id)
						if (error) throw new Error(`Failed to delete wa_auth_keys: ${error.message}`)
					}
				},
			},
		},
		saveCreds,
	}
}

