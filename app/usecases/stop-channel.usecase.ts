import { drive_v3 } from "googleapis";

import * as log from "../logger.ts"
import { ChannelRespository } from "../repositories.ts";
import { AppConfigRepository } from "../repositories/app-config.repo.ts";



export function stopChannelUseCase(configRepo: AppConfigRepository, channels: ChannelRespository) {

    return async (channelId: string) => {

        const channel = channels.get(channelId)

        if (!channel) {
            throw new Error(`Channel ${channelId} not found`)
        }



        const drive = await configRepo.getDrive(channel.owner)

        if (!drive) {
            throw new Error(`No drive found for ${channel.owner}`)
        }



        await drive.channels.stop({
            requestBody: {
                id: channelId,
                resourceId: channel.ressourceId
            }
        })

        log.info("Channel", channelId, ":", "Stopped channel", channel.owner, channel.kind, channel.expiration)

    }

}