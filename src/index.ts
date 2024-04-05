import { Context, Schema, h, Universal, Time } from 'koishi'
import { randomSelect, isSameDay } from './utils'
import { } from '@koishijs/cache'
import { } from 'koishi-plugin-cron'

export const name = 'waifu'
export const inject = ['cache', 'cron']

declare module '@koishijs/cache' {
  interface Tables {
    [key: `waifu_members_${string}`]: Universal.GuildMember
    [key: `waifu_members_active_${string}`]: string
  }
}

export interface Config {
  avoidNtr: boolean
  onlyActiveUser: boolean
  activeDays: number
  forceMarry: boolean
  excludeUsers: {
    uid: string
    note?: string
  }[]
}

export const Config: Schema<Config> = Schema.object({
  avoidNtr: Schema.boolean().default(false),
  onlyActiveUser: Schema.boolean().default(false),
  activeDays: Schema.natural().default(7),
  forceMarry: Schema.boolean().default(false),
  excludeUsers: Schema.array(Schema.object({
    uid: Schema.string().required(),
    note: Schema.string()
  })).role('table').default([{ uid: 'red:2854196310', note: 'Q群管家' }])
}).i18n({
  'zh-CN': require('./locales/zh-CN'),
})

export function apply(ctx: Context, cfg: Config) {
  ctx.i18n.define('zh-CN', require('./locales/zh-CN'))

  // 成员列表暂存
  let allMemberList = {}
  // 婚姻表，每天四点清空
  let relationMap: {[key: string]: Universal.GuildMember} = {}
  ctx.cron('0 4 * * *', () => {
    relationMap = {}
  })
  // gid: platform:guildId
  // fid: platform:guildId:userId
  // sid: platform:selfId

  ctx.guild().on('message-created', async (session) => {
    const member: Universal.GuildMember = session.event.member || { user: session.event.user }
    await ctx.cache.set(`waifu_members_${session.gid}`, session.userId, member, 2 * Time.day)
    await ctx.cache.set(`waifu_members_active_${session.gid}`, session.userId, '', cfg.activeDays * Time.day)
  })

  ctx.on('guild-member-removed', (session) => {
    ctx.cache.delete(`waifu_members_${session.gid}`, session.userId)
    ctx.cache.delete(`waifu_members_active_${session.gid}`, session.userId)
    if (!allMemberList[session.gid]) allMemberList[session.gid] = {}
    delete allMemberList[session.gid][session.userId]
  })

  ctx.on('guild-member-added', (session) => {
    if (!allMemberList[session.gid]) allMemberList[session.gid] = {}
    allMemberList[session.gid][session.userId] = session.event.user
  })

  ctx.command('waifu')
    .alias('marry', '娶群友', '今日老婆')
    .action(async ({ session }) => {
      if (!session.guildId) {
        return session.text('.members-too-few')
      }

      const marriage = relationMap[session.fid]
      if (marriage) {
        return session.text('.marriages', {
          quote: h.quote(session.messageId),
          name: marriage.nick || marriage.user.nick || marriage.user.name,
          avatar: h.image(marriage.avatar || marriage.user.avatar)
        })
      }

      let memberList: { [key:string]: Universal.GuildMember } = allMemberList[session.guildId]
      if (!memberList || (Object.keys(memberList).length === 0)) {
        memberList = {}
        try {        
          let { data, next } = await session.bot.getGuildMemberList(session.guildId)
          data.forEach(u => memberList[u.user.id] = u)
          while (next) {
            let loopResult = await session.bot.getGuildMemberList(session.guildId, next)
            next = loopResult.next
            loopResult.data.forEach(u => memberList[u.user.id] = u)
          }
        } catch { }
        if (!memberList || (Object.keys(memberList).length === 0)) {
          for await (const [, value] of ctx.cache.entries(`waifu_members_${session.gid}`)) {
            memberList[value.user.id] = value
          }
        }
      }
      allMemberList[session.guildId] = memberList

      const excludes = cfg.excludeUsers.map(({ uid }) => uid)
      excludes.push(session.uid, session.sid)
      excludes.forEach(ex => delete memberList[ex])

      let list = Object.keys(memberList).map(member => memberList[member])
        .filter(member => !member.user.isBot)

      if (cfg.onlyActiveUser) {
        let activeList: string[] = []
        for await (const value of ctx.cache.keys(`waifu_members_active_${session.gid}`)) {
          activeList.push(value)
        }
        list = list.filter(v => activeList.find(active => active === v.user.id))
      }

      if (list.length === 0) return session.text('.members-too-few')

      let waifuList = list.filter(u => u.user.id !== session.userId)
      if (cfg.avoidNtr) {
        waifuList = waifuList.filter(waifu => !Object.keys(relationMap).find(lover => lover.split(':')[2] == waifu.user.id))
      }
      let waifu = randomSelect(waifuList)
      if (waifuList.length === 0) return session.text('.members-too-few')

      let waifuFid = `${session.platform}:${session.guildId}:${waifu.user.id}`
      relationMap[session.fid] = waifu
      relationMap[waifuFid] = session.event.member

      return session.text('.marriages', {
        quote: h.quote(session.messageId),
        name: waifu.nick || waifu.user.nick || waifu.user.name,
        avatar: h.image(waifu.avatar || waifu.user.avatar)
      })
    })

  if (cfg.forceMarry) {
    ctx.command('force-marry <target:user>')
      .alias('强娶')
      .action(async ({ session }, target) => {
        if (!session.guildId) {
          return session.text('.members-too-few')
        }
        if (!target) {
          return session.text('.no-target', {
            quote: h.quote(session.messageId)
          })
        }

        const targetId = target.replace(session.platform + ':', '')
        if (targetId === session.userId) return session.text('.target-self')

        // 获取成员列表
        let memberList: { [key:string]: Universal.GuildMember } = allMemberList[session.guildId]
        if (!memberList || (Object.keys(memberList).length === 0)) {
          memberList = {}
          try {        
            let { data, next } = await session.bot.getGuildMemberList(session.guildId)
            data.forEach(u => memberList[u.user.id] = u)
            while (next) {
              let loopResult = await session.bot.getGuildMemberList(session.guildId, next)
              next = loopResult.next
              loopResult.data.forEach(u => memberList[u.user.id] = u)
            }
          } catch { }
          if (!memberList || (Object.keys(memberList).length === 0)) {
            for await (const [, value] of ctx.cache.entries(`waifu_members_${session.gid}`)) {
              memberList[value.user.id] = value
            }
          }
        }
        allMemberList[session.guildId] = memberList
      
        let waifu = memberList[targetId]
        let waifuFid = `${session.platform}:${session.guildId}:${waifu.user.id}`
        if (cfg.avoidNtr) {
          if (relationMap[waifuFid]) {
            return session.text('.other-waifu', { quote: h.quote(session.messageId), name: waifu.user.name })
          }
        }
        relationMap[session.fid] = waifu
        relationMap[waifuFid] = session.event.user
        return session.text('.force-marry', {
          quote: h.quote(session.messageId),
          name: waifu.nick || waifu.user.nick || waifu.user.name,
          avatar: h.image(waifu.avatar || waifu.user.avatar)
        })
      })
  }
}
