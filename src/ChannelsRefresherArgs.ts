// https://github.com/andreashuber69/lightning-node-operator/develop/README.md
import type {
    AuthenticatedLightningArgs, SubscribeToChannelsChannelClosedEvent, SubscribeToChannelsChannelOpenedEvent,
} from "lightning";
import { subscribeToChannels } from "lightning";
import type { Channel } from "./Channel.js";
import { FullRefresherArgs } from "./FullRefresherArgs.js";
import { getChannels } from "./getChannels.js";
import { log } from "./Logger.js";

export class ChannelsRefresherArgs extends FullRefresherArgs<"channels", Channel> {
    public constructor(args: AuthenticatedLightningArgs) {
        super("channels", subscribeToChannels(args), args);
    }

    public override onChanged(listener: () => void) {
        const handler = (e: SubscribeToChannelsChannelClosedEvent | SubscribeToChannelsChannelOpenedEvent) => {
            log(`channel ${e.id}`);
            listener();
        };

        this.emitter.on("channel_opened", handler);
        this.emitter.on("channel_closed", handler);
    }

    protected override async getAllData() {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        return await getChannels({ ...this.args, is_public: true });
    }
}
