import fs from 'node:fs/promises'

import { getLogger, Logger } from '@logtape/logtape'

import { Config } from './types'
import { ConfigRepository } from './repositories'



export class ConfigFileRepository implements ConfigRepository {

    constructor (
        private readonly logger: Logger,
        private readonly path: string
    ) {}

    public async read () {

        this.logger.debug(`Reading config from ${this.path}`)

        const data = await fs.readFile(this.path, 'utf-8')
        const json = JSON.parse(data)
        const res = await Config.safeParseAsync(json)

        if (!res.success) {
            throw new Error(`Failed to parse config: ${res.error.message}`)
        }

        return res.data
        
    }


    public async write (config: Config) {

        this.logger.debug(`Writing config to ${this.path}`)

        const json = JSON.stringify(config, null, 2)
        await fs.writeFile(this.path, json)
    }
}