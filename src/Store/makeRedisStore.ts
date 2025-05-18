// makeRedisStore.ts
import type { Redis } from 'ioredis'
import type { BaileysEventEmitter } from '../Types/Events'
import type { WAMessage, Chat, Contact, GroupMetadata } from '../Types'
import type { proto } from '../../WAProto'

type MessageDirection = 'latest' | 'earliest'

type RedisStore = {
  bind: (ev: BaileysEventEmitter) => void
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

export default function makeRedisStore(deviceId: string, redis: Redis): RedisStore {
  const prefix = `wa:${deviceId}`

  return {
    bind(ev) {
      ev.on('messaging-history.set', async ({ chats, contacts, messages }) => {
        for (const chat of chats) {
          await redis.set(`${prefix}:chatmeta:${chat.id}`, JSON.stringify(chat))
          await redis.sadd(`${prefix}:knownJIDs`, chat.id)
        }
        for (const contact of contacts) {
          await redis.set(`${prefix}:contact:${contact.id}`, JSON.stringify(contact))
        }
        for (const msg of messages) {
          const jid = msg.key.remoteJid
          if (jid) {
            await redis.rpush(`${prefix}:chat:${jid}:messages`, JSON.stringify(msg))
            await redis.sadd(`${prefix}:knownJIDs`, jid)
          }
        }
      })

      ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
          const jid = msg.key.remoteJid
          if (jid) {
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
          await redis.set(`${prefix}:contact:${contact.id}`, JSON.stringify(contact))
        }
      })

      ev.on('groups.upsert', async (groups) => {
        for (const group of groups) {
          await redis.set(`${prefix}:groupmeta:${group.id}`, JSON.stringify(group))
        }
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
      const result: (Chat & { jid: string; name: string })[] = []
      for (const jid of jids) {
        const chat = await this.getChat(jid)
        const contact = await this.getContact(jid)
        result.push({
          jid,
          name: (((chat && 'name' in chat ? chat.name : null) ?? contact?.name ?? contact?.notify) ?? ''),
          ...(chat || {})
        })
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
      const raw = await redis.get(`${prefix}:groupmeta:${jid}`)
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
