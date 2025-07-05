import path from "node:path"
import fs from "node:fs/promises"

import { drive_v3, google } from "googleapis"
import { JWT } from "google-auth-library"

import * as env from "./env"
import { Account, DriveAccount } from "./types"




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



export const listChangesRecursive = async (account: Account, drive: drive_v3.Drive) => {

    const dataPath = path.normalize(env.DATA_PATH)
    const token = await getChangeToken(account, dataPath).catch(async err => {
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
            await setChangeToken(account, dataPath, res.data.newStartPageToken)
        }

        return changes

    }

    return await fn(token)

}


export const getSrcFolderChangeTokenFilepath = (account: Account, dataPath: string) => {
    return path.join(dataPath, `${account.id}.${account.props.drive_src_folder_id}.change-token.txt`)
}


export const getChangeToken = async (account: Account, dataPath: string) => {
    
    const filepath = getSrcFolderChangeTokenFilepath(account, dataPath)
    
    const raw = await fs.readFile(filepath, "utf-8")
    const token = raw.trim()
    return token
}



export const setChangeToken = async (account: Account, dataPath: string, token: string) => {

    const filepath = getSrcFolderChangeTokenFilepath(account, dataPath)

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