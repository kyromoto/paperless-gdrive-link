import "dotenv/config"

import { configure, getConsoleSink } from "@logtape/logtape";

import { ConfigFileRepository } from "./try-out/config";
import { Processor } from "./processor";



(async () => {

    const CONFIG_PATH = process.env.CONFIG_PATH;

    if (!CONFIG_PATH) {
        console.error('Missing CONFIG_PATH environment variable');
        process.exit(1);
    }

    await configure({
        sinks: { console: getConsoleSink() },
        loggers: [
            { category: [], sinks: ["console"] },
            { category: ["logtape" ,"meta"], sinks: ["console"], lowestLevel: "trace" }
        ]
    })

    const config = await new ConfigFileRepository(CONFIG_PATH).read();
    const processor = new Processor(config);

    await processor.start()

})().catch(error => {
    console.error('Failed to start application', error);
    process.exit(1);
})
