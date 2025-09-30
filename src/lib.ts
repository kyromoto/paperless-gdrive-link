import fs from "node:fs/promises"
import path from "node:path"

import { drive_v3, google } from "googleapis"
import { JWT } from "google-auth-library"

import { Account, Config, DriveAccount } from "./types"
import { Logger } from "@logtape/logtape"
import { DriveFile, FileProcessor } from "./file-processor"




export const listFilesRecursive = async (account: Account, drive: drive_v3.Drive) => {

    const fn = async (pageToken?: string) : Promise<Array<drive_v3.Schema$File>> => {

        const res = await drive.files.list({
            q: `'${account.props.drive_src_folder_id}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
            fields: 'nextPageToken, files(id, name, size, properties, mimeType, createdTime, modifiedTime)',
            orderBy: "modifiedTime desc",
            pageSize: 100,
            ...(pageToken && { pageToken })
        })

        const files = res.data.files || [];
        const next = res.data.nextPageToken;

        if (!next) return files;

        return files.concat(await fn(next));

    }

    return await fn()

}



export const listChangesRecursive = async (config: Config, account: Account, drive: drive_v3.Drive) => {

    const tokenPath = path.join(config.server.data_path, "tokens")

    await fs.access(tokenPath, fs.constants.W_OK).catch(async err => {
        await fs.mkdir(tokenPath, { recursive: true })
    })

    const token = await getChangeToken(account, tokenPath).catch(async err => {
        const res = await drive.changes.getStartPageToken({})

        if (!res.data.startPageToken) {
            throw new Error(`Failed to get start page token for ${account.name}`)
        }

        return res.data.startPageToken

    })

    const fn = async (pageToken?: string): Promise<drive_v3.Schema$Change[]> => {
        
        const res = await drive.changes.list({
            spaces: 'drive',
            includeRemoved: true,
            pageSize: 100,
            ...(pageToken && { pageToken })
        })

        const changes = res.data.changes || [];
        const next = res.data.nextPageToken;

        if (next) {
            return changes.concat(await fn(next))
        }

        if (res.data.newStartPageToken) {
            await setChangeToken(account, tokenPath, res.data.newStartPageToken)
        }

        return changes

    }

    return await fn(token)

}


export const getSrcFolderChangeTokenFilepath = (account: Account, storePath: string) => {
    return path.join(storePath, `${account.id}.${account.props.drive_src_folder_id}.change-token.txt`)
}


export const getChangeToken = async (account: Account, storePath: string) => {
    
    const filepath = getSrcFolderChangeTokenFilepath(account, storePath)
    
    const raw = await fs.readFile(filepath, "utf-8")
    const token = raw.trim()
    return token
}



export const setChangeToken = async (account: Account, storePath: string, token: string) => {

    const filepath = getSrcFolderChangeTokenFilepath(account, storePath)

    await fs.writeFile(filepath, token, { encoding: "utf-8" })
}



export const stopChannels = async (channelIds: string[], drive: drive_v3.Drive) => {

    for (const channelId of channelIds) {
        await drive.channels.stop({
            requestBody: {
                id: channelId
            }
        }).catch(err => {
            console.error(`Failed to stop channel with id ${channelId}: ${err.message}`, { error: err })
        })
    }

}



export const getDriveClient = (drive: DriveAccount) => {
    
    return google.drive({
        version: 'v3',
        auth: new JWT({
            email: drive.props.credentials.client_email,
            key: drive.props.credentials.private_key,
            scopes: ['https://www.googleapis.com/auth/drive']
        })
    })

}



export const createNotificationTask = (logger: Logger, processor: FileProcessor) => async () => {
    logger.info(`Getting unprocessed files...`)
    return await processor.getUnprocessedFiles("changes")
}



export const createFileTask = (logger: Logger, processor: FileProcessor, file: DriveFile) => async () => {
    logger.info(`Processing file ${file.name}...`, { file })
    await processor.processFile(file)
}