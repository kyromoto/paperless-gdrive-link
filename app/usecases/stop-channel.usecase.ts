import { drive_v3 } from "googleapis";

import * as log from "../logger.ts"
import { ChannelRespository } from "../repositories/channel.repo.ts";
import { AppConfig, getGDriveClient } from "../repositories/config.repo.ts";



export function stopChannelUseCase(config: AppConfig, channels: ChannelRespository) {

    return async (channelId: string) => {

        const channel = channels.get(channelId)

        if (!channel) {
            throw new Error(`Channel ${channelId} not found`)
        }



        const gdrive = await getGDriveClient(channel.owner, config)

        if (!gdrive) {
            throw new Error(`No drive found for ${channel.owner}`)
        }



        await gdrive.channels.stop({
            requestBody: {
                id: channelId,
                resourceId: channel.ressourceId
            }
        })

        log.info("Channel", channelId, ":", "Stopped channel", channel.owner, channel.kind, channel.expiration)

    }

}