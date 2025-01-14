import * as base64 from "@std/encoding/base64"

import { drive_v3 } from "googleapis"

import { log } from "../logger.ts"
import { AppConfig, getAccount, getChangeToken, getGDriveClient, setChangeToken } from "../repositories/config.repo.ts";




export function downloadedAddedFilesUseCase(config: AppConfig) {

    return async (owner: string) => {

        try {

        const account = getAccount(owner, config)
        const drive = await getGDriveClient(owner, config)
        const changeToken = await getChangeToken(owner, config)

        if (!account) {
            throw new Error(`Account ${owner} not found`)
        }

        if (!drive) {
            throw new Error(`No drive found for ${owner}`)
        }

        const { changes, newStartPageToken } = await listChangesRecursive(drive, config, owner)(changeToken)

        log.info("Fetched", changes.length, "changes")
        log.debug(JSON.stringify(changes, null, 2))



        const files = await listFilesRecursive(drive, account.google_drive.folder_id)()

        log.info("Fetched", files.length, "files")



        const addedFiles = files.filter(file => {
            return !! changes.find(change => change.fileId === file.id)
        })

        log.info("Found", addedFiles.length, "added files")
        log.debug(JSON.stringify(addedFiles, null, 2))


        await transferFilesRecursive(drive, config, owner)(addedFiles)

        if (!newStartPageToken) {
            throw new Error("No new start page token")
        }

        await setChangeToken(owner, newStartPageToken, config)


        } catch (err) {
            throw new Error("Download files failed", {
                cause: err
            })
        }

    }

}




const listChangesRecursive = (drive: drive_v3.Drive) => {

    const fn = async (token?: string): Promise<{ newStartPageToken?: string, changes: drive_v3.Schema$Change[] }> => {
        const res = await drive.changes.list({
            spaces: "drive",
            includeRemoved: true,
            pageSize: 1000,
            ...(token && { pageToken: token }),
        })
    
        const curr = res.data.changes || []
    
        if (!res.data.nextPageToken) {
            return {
                newStartPageToken: res.data.newStartPageToken,
                changes: curr
            }
        }
    
        return {
            newStartPageToken: res.data.newStartPageToken,
            changes: [...curr, ...(await fn(res.data.nextPageToken))]
        }
    }

    return fn

}



const listFilesRecursive = (drive: drive_v3.Drive, folderId: string) => {

    const fn = async (nextPageToken?: string): Promise<drive_v3.Schema$File[]> => {
        
        const res = await drive.files.list({
            spaces: "drive",
            q: `'${folderId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
            orderBy: "modifiedTime desc",
            fields: 'nextPageToken, files(id, name, size, properties, mimeType, createdTime, modifiedTime)',
            pageSize: 1000,
            ...(nextPageToken && { pageToken: nextPageToken })
        })
    
        const curr = res.data.files || []
    
        if (!res.data.nextPageToken) {
            return curr
        }
    
        return [...curr, ...(await fn(res.data.nextPageToken))]

    }

    return fn;

}




const transferFilesRecursive = (drive: drive_v3.Drive, appConfig: AppConfig, owner: string) => {


    const account = appConfig.accounts.find(item => item.name === owner)

    if (!account) {
        throw new Error(`Unknown drive ${owner}`)
    }


    const fn = async (files: drive_v3.Schema$File[]) => {

        if (files.length === 0) {
            return
        }
    
        const [head, ...tail] = files
    
    
    
        if (!head || !head.id || !head.name || !head.size || !head.createdTime || !head.modifiedTime || !head.mimeType) {
            throw new Error("Invalid file", {
                cause: head
            })
        }
    
    
        log.info("Downloading file", head.name, head.size, "bytes", owner)
    
        const downloadResponse = await drive.files.get({
            fileId: head.id,
            alt: "media"
        }, {
            responseType: "arraybuffer"
        })


        log.info("Uploaded file", head.name, head.size, "bytes", owner)

        const url = account.paperless_ngx.server_url + "/api/documents/post_document/"
        
        const authStr = [
            account.paperless_ngx.credentials.username,
            account.paperless_ngx.credentials.password
        ].join(":") 
        const authBuffer = new TextEncoder().encode(authStr)
        const authBase64 = base64.encodeBase64(authBuffer)
        
        const file = new File([downloadResponse.data], head.name, {
            type: head.mimeType
        })

        const body = new FormData()

        body.append("document", file)
        body.append("created", head.createdTime)

        const uploadResponse = await fetch(url, {
            method: "POST",
            headers: {
                Authorization: `Basic ${authBase64}`
            },
            body
        })

        const text = await uploadResponse.text()

        if (!uploadResponse.ok) {
            log.error("Upload failed", await uploadResponse.text())
            throw new Error("Upload failed", { cause: text })
        }
    
        await fn(tail)

    }

    return fn

}