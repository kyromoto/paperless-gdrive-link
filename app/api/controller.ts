import { Context } from "@oak/oak/context";

import { log } from "../logger.ts"
import { Queue } from "../queue.ts";
import { AppConfig } from "../repositories/config.repo.ts";
import { ChannelRespository } from "../repositories/channel.repo.ts";


export type WebhookControllerDeps = {
    config: AppConfig
    channels: ChannelRespository
    downloadAddedFiles: (owner: string) => Promise<void>
}


class WebhookQueue extends Queue<string> {

  constructor(
    private appConfig: AppConfig,
    private channels: ChannelRespository,
    private downloadAddedFiles: (owner: string) => Promise<void>
  ) {
    super()
  }

  protected override async processTask(channelId: string): Promise<void> {
    
    const channel = this.channels.get(channelId)

    if (!channel) {
      
      log.error("Channel", channelId, ":", "Channel not found")
      
      throw new Error("Failed to process task", {
        cause: `Channel ${channelId} not found`
      })

    }

    const account = this.appConfig.accounts.find(item => item.name === channel.owner)

    if (!account) {
      
      log.error("Channel", channelId, ":", "User config not found", channel.owner)
      
      throw new Error("Failed to process task", {
        cause: `User config ${channel.owner} not found`
      })

    }
      
    await this.downloadAddedFiles(account.name)

  }
  
}


export function WebhookController (deps: WebhookControllerDeps) {

    const { config, channels, downloadAddedFiles } = deps
    const queue = new WebhookQueue(config, channels, downloadAddedFiles)

    return async (ctx: Context<{ channelId: string }>) => {

      const state = ctx.request.headers.get("X-Goog-Resource-State")
        
      if (state === "sync") {
        log.info("Channel", ctx.state.channelId, ":", "Ignoring notification", state)
        return
      }

      await queue.addToQueue(ctx.state.channelId)

    }

}