// makeRedisStore.ts
import type { Redis } from 'ioredis'
import type { BaileysEventEmitter } from '../Types/Events'
import type { WAMessage, Chat, Contact, GroupMetadata } from '../Types'
import { proto } from '../../WAProto'

type MessageDirection = 'latest' | 'earliest'

type RedisStore = {
  bind: (ev: BaileysEventEmitter, sock: any) => void
  getKnownJIDs: () => Promise<string[]>
  getChat: (jid: string) => Promise<Chat | null>
  getContact: (jid: string) => Promise<Contact | null>
  getAllChats: () => Promise<(Chat & { jid: string; name: string })[]>
  getMessages: (jid: string) => Promise<WAMessage[]>
  getMessage: (jid: string, id: string) => Promise<WAMessage | undefined>
  getGroupMetadata: (jid: string) => Promise<GroupMetadata | null>
  mostRecentMessage: (jid: string) => Promise<Partial<WAMessage> | null>
  getSingleChatMessages: (jid: string, count?: number, direction?: MessageDirection) => Promise<WAMessage[]>
  toJSON: () => Promise<Record<string, any>>
}

export function makeRedisStore(deviceId: string, redis: Redis): RedisStore {
  const prefix = `wa:${deviceId}`
  let socketRef: any

  return {
    bind(ev, sock) {
      socketRef = sock
      const deviceId = sock.user?.id || 'unknown_device'

      ev.on('messaging-history.set', async ({ chats, contacts, messages, isLatest, syncType }) => {
        const chatCount = Array.isArray(chats) ? chats.length : 0
        const contactCount = Array.isArray(contacts) ? contacts.length : 0

        let allMessages: any[] = []
        if (messages) {
          if (typeof (messages as any).all === 'function') {
            allMessages = (messages as any).all()
          } else if (Array.isArray(messages)) {
            allMessages = messages
          }
        }

        console.log(`[${deviceId}] 🧩 messaging-history.set fired. Chats: ${chatCount}, Contacts: ${contactCount}, Messages: ${allMessages.length}`)

        try {
          for (const msg of allMessages) {
            if (!msg.message && msg.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT) {
              console.warn(`[${deviceId}] ⚠️ Skipped invalid/decryption-failed message: ${msg.key.id}`)
              continue
            }

            const jid = msg.key.remoteJid
            if (jid && msg.message) {
              await redis.rpush(`${prefix}:chat:${jid}:messages`, JSON.stringify(msg))
              await redis.sadd(`${prefix}:knownJIDs`, jid)
            }
          }
        } catch (err) {
          console.error(`[${deviceId}] ❌ Manual fallback failed: ${err?.message || err}`)
        }

        for (const chat of chats) {
          await redis.set(`${prefix}:chatmeta:${chat.id}`, JSON.stringify(chat))
          await redis.sadd(`${prefix}:knownJIDs`, chat.id)

          if (chat.id.endsWith('@g.us')) {
            try {
              const meta = await sock.groupMetadata(chat.id)
              await redis.set(`${prefix}:groupmeta:${chat.id}`, JSON.stringify(meta))
            } catch { }
          }
        }

        for (const contact of contacts) {
          await redis.set(`${prefix}:contact:${contact.id}`, JSON.stringify(contact))
        }
      })

      ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
          const jid = msg.key.remoteJid
          if (jid && msg.message) {
            await redis.rpush(`${prefix}:chat:${jid}:messages`, JSON.stringify(msg))
            await redis.sadd(`${prefix}:knownJIDs`, jid)
          }
        }
      })

      ev.on('chats.upsert', async (chats) => {
        for (const chat of chats) {
          await redis.set(`${prefix}:chatmeta:${chat.id}`, JSON.stringify(chat))
          await redis.sadd(`${prefix}:knownJIDs`, chat.id)
        }
      })

      ev.on('contacts.upsert', async (contacts) => {
        for (const contact of contacts) {
          const key = `${prefix}:contact:${contact.id}`
          const existingRaw = await redis.get(key)
          const existing = existingRaw ? JSON.parse(existingRaw) : {}

          // Merge only if new name is available or fallback to old
          const merged = {
            ...existing,
            ...contact,
            name: contact.name || existing.name,
            verifiedName: contact.verifiedName || existing.verifiedName,
            notify: contact.notify || existing.notify
          }

          await redis.set(key, JSON.stringify(merged))
        }
      })


      ev.on('groups.upsert', async (groups) => {
        for (const group of groups) {
          await redis.set(`${prefix}:groupmeta:${group.id}`, JSON.stringify(group))
        }
      })

      ev.on('groups.update', async (groups) => {
        for (const group of groups) {
          const key = `${prefix}:groupmeta:${group.id}`
          const existing = await redis.get(key)
          const existingMeta = existing ? JSON.parse(existing) : {}

          const merged = {
            ...existingMeta,
            ...group,
            lastGroupUpdate: {
              updatedAt: Date.now()
            }
          }

          await redis.set(key, JSON.stringify(merged))
        }
      })

      ev.on('group-participants.update', async (update) => {
        const { id, participants, action } = update
        const metaKey = `${prefix}:groupmeta:${id}`

        try {
          const existing = await redis.get(metaKey)
          const existingMeta = existing ? JSON.parse(existing) : {}

          let latestMeta: any = {}
          try {
            latestMeta = await sock.groupMetadata(id)
          } catch { }

          const participantCount = latestMeta.participants?.length || 0
          const adminList = latestMeta.participants?.filter((p: any) => p.admin)?.map((p: any) => p.id) || []

          const mergedMeta = {
            ...existingMeta,
            ...latestMeta,
            lastParticipantUpdate: {
              participants,
              action,
              updatedAt: Date.now(),
              participantCount,
              adminList
            }
          }

          await redis.set(metaKey, JSON.stringify(mergedMeta))
        } catch { }
      })
    },

    async getKnownJIDs() {
      return await redis.smembers(`${prefix}:knownJIDs`)
    },

    async getChat(jid) {
      const raw = await redis.get(`${prefix}:chatmeta:${jid}`)
      return raw ? JSON.parse(raw) : null
    },

    async getContact(jid) {
      const raw = await redis.get(`${prefix}:contact:${jid}`)
      return raw ? JSON.parse(raw) : null
    },

    async getAllChats() {
      const jids = await this.getKnownJIDs()
      const result: (Chat & { jid: string; name: string; profilePictureUrl?: string; lastMessage?: Partial<WAMessage>; unreadCount?: number; isGroup?: boolean })[] = []
      for (const jid of jids) {
        const chat = await this.getChat(jid)
        const contact = await this.getContact(jid)
        if (chat) {
          const profilePictureUrl = contact?.imgUrl ?? undefined
          const lastMsgRaw = await redis.lindex(`${prefix}:chat:${jid}:messages`, -1)
          const lastMessage = lastMsgRaw ? JSON.parse(lastMsgRaw) : undefined
          const unreadCount = chat.unreadCount ?? 0
          const isGroup = jid.endsWith('@g.us')
          result.push({
            ...chat,
            jid,
            name: (contact?.name ?? contact?.notify ?? chat?.name ?? jid.split('@')[0]) as string,
            profilePictureUrl,
            lastMessage,
            unreadCount,
            isGroup
          })
        }
      }
      return result
    },

    async getMessages(jid) {
      const raw = await redis.lrange(`${prefix}:chat:${jid}:messages`, 0, -1)
      return raw.map(m => JSON.parse(m))
    },

    async getMessage(jid, id) {
      const messages = await this.getMessages(jid)
      return messages.find(m => m.key.id === id)
    },

    async getGroupMetadata(jid) {
      const key = `${prefix}:groupmeta:${jid}`
      let raw = await redis.get(key)

      if (!raw && socketRef?.groupMetadata) {
        try {
          const latestMeta = await socketRef.groupMetadata(jid)
          await redis.set(key, JSON.stringify(latestMeta))
          return latestMeta
        } catch {
          return null
        }
      }

      return raw ? JSON.parse(raw) : null
    },

    async mostRecentMessage(jid) {
      const raw = await redis.lindex(`${prefix}:chat:${jid}:messages`, -1)
      if (!raw) return null
      const msg = JSON.parse(raw)
      return {
        key: msg.key,
        messageTimestamp: msg.messageTimestamp,
        messageStubType: msg.messageStubType
      }
    },

    async getSingleChatMessages(jid, count = 20, direction: MessageDirection = 'latest') {
      const listKey = `${prefix}:chat:${jid}:messages`
      let raw
      if (direction === 'latest') {
        const total = await redis.llen(listKey)
        const start = Math.max(total - count, 0)
        raw = await redis.lrange(listKey, start, total - 1)
      } else {
        raw = await redis.lrange(listKey, 0, count - 1)
      }
      return raw.map(m => JSON.parse(m))
    },

    async toJSON() {
      const jids = await this.getKnownJIDs()
      const chatmeta: Record<string, any> = {}
      const messages: Record<string, any> = {}
      const contacts: Record<string, any> = {}

      for (const jid of jids) {
        chatmeta[jid] = await this.getChat(jid)
        messages[jid] = await this.getMessages(jid)
        contacts[jid] = await this.getContact(jid)
      }

      return {
        chatmeta,
        messages,
        contacts
      }
    }
  }
}
