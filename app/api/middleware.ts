import { Context, Next } from "@oak/oak"

import { log } from "./../logger.ts"

export function matchChannelId (channels: Map<string, { kind: string, expiration: string }>) {
    
    return async (ctx: Context<{ channelId?: string }>, next: Next) => {

        const channelId = ctx.request.headers.get("X-Goog-Channel-ID")
    
        if (!channelId) {
            log.error("channel", channelId, ":", "Missing X-Goog-Channel-ID header")
            ctx.response.status = 400
            return
        }


        if (!channels.has(channelId)) {
            log.warn("Channel", channelId, ":", "Skip unknown channel")
            return
        }

        ctx.state.channelId = channelId

        await next()
    }

}



export function logWebhook () {

    return async (ctx: Context<{ channelId?: string }>, next: Next) => {

        if (!ctx.state.channelId) {
            log.error("Missing channelId in state")
            ctx.response.status = 500
            return
        }

        const state = ctx.request.headers.get("X-Goog-Resource-State")

        log.info("Channel", ctx.state.channelId, ":", "Got notification", state)

        log.debug("Channel", ctx.state.channelId, ":", "Notification headers:", JSON.stringify(ctx.request.headers, null, 2))
        log.debug("Channel", ctx.state.channelId, ":", "Notification body   :", JSON.stringify(ctx.request.body, null, 2))

        await next()

    }

}