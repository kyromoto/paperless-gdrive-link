import fs from 'node:fs/promises'

import * as yml from "yaml";
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

        const raw = await fs.readFile(this.path, 'utf-8')
        const data = yml.parse(raw)
        const res = await Config.safeParseAsync(data)

        if (!res.success) {
            throw new Error(`Failed to parse config: ${res.error.message}`)
        }

        return res.data
        
    }


    public async write (config: Config) {

        this.logger.debug(`Writing config to ${this.path}`)

        const raw = yml.stringify(config)
        await fs.writeFile(this.path, raw)
    }
}