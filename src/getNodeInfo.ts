import EventEmitter from "node:events";
import type {
    AuthenticatedLightningArgs,
    GetIdentityResult,
    SubscribeToChannelsChannelClosedEvent,
    SubscribeToChannelsChannelOpenedEvent,
    SubscribeToForwardsForwardEvent,
    SubscribeToPastPaymentsPaymentEvent,
    SubscribeToPaymentsPaymentEvent,
} from "lightning";
import { getIdentity, subscribeToChannels, subscribeToForwards, subscribeToPayments } from "lightning";
import { getChannels } from "./getChannels.js";
import { getForwards } from "./getForwards.js";
import { getPayments } from "./getPayments.js";
import type { YieldType } from "./YieldType.js";

// eslint-disable-next-line @typescript-eslint/naming-convention
const toSortedArray = async <T extends { readonly created_at: string }>(generator: AsyncGenerator<T>) => {
    const result = new Array<T>();

    for await (const element of generator) {
        result.push(element);
    }

    result.sort((a, b) => new Date(a.created_at).valueOf() - new Date(b.created_at).valueOf());
    return result;
};

const getSortedForwards = async (lnd: AuthenticatedLightningArgs, after: string, before: string) =>
    await toSortedArray(getForwards({ ...lnd, after, before }));

const getSortedPayments = async (lnd: AuthenticatedLightningArgs, after: string, before: string) =>
    // eslint-disable-next-line @typescript-eslint/naming-convention
    await toSortedArray(getPayments({ ...lnd, created_after: after, created_before: before }));

const getRange = (days: number) => {
    const before = new Date(Date.now()).toISOString();
    const after = new Date(new Date(before).valueOf() - (days * 24 * 60 * 60 * 1000)).toISOString();

    return { after, before };
};

const nodeInfoEventName = "change";

class NodeInfoImpl implements NodeInfo {
    public constructor(
        private readonly lnd: AuthenticatedLightningArgs,
        private readonly days: number,
        public readonly identity: GetIdentityResult,
        public readonly channels: Channel[],
        public readonly forwards: Forward[],
        public readonly payments: Payment[],
    ) {}

    public on(_eventName: typeof nodeInfoEventName, listener: () => void) {
        this.changeEmitter.on(nodeInfoEventName, listener);

        if (this.changeEmitter.listenerCount(nodeInfoEventName) === 1) {
            this.channelEmitter = subscribeToChannels(this.lnd);

            this.channelEmitter.on(
                "channel_opened",
                (e: SubscribeToChannelsChannelOpenedEvent) => void this.handleChannelOpen(e),
            );

            this.channelEmitter.on(
                "channel_closed",
                (e: SubscribeToChannelsChannelClosedEvent) => this.handleChannelClose(e),
            );

            this.forwardEmitter = subscribeToForwards(this.lnd);
            this.forwardEmitter.on("forward", (e: SubscribeToForwardsForwardEvent) => void this.handleForward(e));
            this.paymentEmitter = subscribeToPayments(this.lnd);
            this.paymentEmitter.on("confirmed", (e: SubscribeToPastPaymentsPaymentEvent) => void this.handlePayment(e));
        }

        return this;
    }

    public off(_eventName: typeof nodeInfoEventName, listener: () => void) {
        if (this.changeEmitter.listenerCount(nodeInfoEventName) === 1) {
            this.channelEmitter?.removeAllListeners();
            this.forwardEmitter?.removeAllListeners();
            this.paymentEmitter?.removeAllListeners();
        }

        this.changeEmitter.off(nodeInfoEventName, listener);
        return this;
    }

    // eslint-disable-next-line @typescript-eslint/naming-convention
    private static removeOutdatedElements<T extends { created_at: string }>(array: T[], after: string) {
        const deleteCount = array.findIndex((v) => v.created_at >= after);
        array.splice(0, deleteCount);
    }

    // eslint-disable-next-line unicorn/prefer-event-target
    private readonly changeEmitter = new EventEmitter();
    private channelEmitter?: EventEmitter;
    private forwardEmitter?: EventEmitter;
    private paymentEmitter?: EventEmitter;

    private async handleChannelOpen(_event: SubscribeToChannelsChannelOpenedEvent) {
        this.channels.splice(0, this.channels.length, ...await getChannels(this.lnd));
        this.emitChange();
    }

    private handleChannelClose({ id }: SubscribeToChannelsChannelClosedEvent) {
        const index = this.channels.findIndex((v) => v.id === id);

        if (index >= 0) {
            this.channels.splice(index, 1);
            this.emitChange();
        }
    }

    // eslint-disable-next-line @typescript-eslint/naming-convention
    private async handleForward({ is_confirmed, at }: SubscribeToForwardsForwardEvent) {
        if (is_confirmed) {
            this.appendAndEmit(this.forwards, await getSortedForwards(this.lnd, at, at), "forwards");
        }
    }

    // eslint-disable-next-line @typescript-eslint/naming-convention
    private async handlePayment({ created_at }: SubscribeToPaymentsPaymentEvent) {
        this.appendAndEmit(this.payments, await getSortedPayments(this.lnd, created_at, created_at), "payments");
    }

    private appendAndEmit<T>(array: T[], newElements: T[], propertyName: keyof NodeInfoBase) {
        array.push(...newElements);

        if (newElements.length !== 1) {
            console.error(`Unexpected ${propertyName}:\n${newElements}`);
        }

        this.emitChange();
    }

    private emitChange() {
        const { after } = getRange(this.days);
        NodeInfoImpl.removeOutdatedElements(this.forwards, after);
        NodeInfoImpl.removeOutdatedElements(this.payments, after);
        this.changeEmitter.emit(nodeInfoEventName);
    }
}

export type Identity = Readonly<GetIdentityResult>;

export type Channel = Readonly<Awaited<ReturnType<typeof getChannels>>[number]>;

export type Forward = Readonly<YieldType<ReturnType<typeof getForwards>>>;

export type Payment = Readonly<YieldType<ReturnType<typeof getPayments>>>;

export interface NodeInfoBase {
    readonly identity: Identity;

    /** The currently open channels. */
    readonly channels: readonly Channel[];

    /** The forwards routed through the node. */
    readonly forwards: readonly Forward[];

    /** The payments made from the node. */
    readonly payments: readonly Payment[];
}

/**
 * Provides various information about a node.
 * @description All time-bound data (like {@link NodeInfo.forwards}) will be sorted earliest to latest. Apart from
 * being sorted, the data is provided as it came from LND. Further sanitation will be necessary, for example, a forward
 * may refer to a channel that is no longer open and will thus not appear in {@link NodeInfo.channels}.
 */
export interface NodeInfo extends NodeInfoBase {
    /**
     * Adds the `listener` function to the end of the listener array for the event named "change".
     * @description Behaves exactly like {@link EventEmitter.on} with the exception that only listeners for the event
     * named `"change"` can be added.
     * @param _eventName Always ignored, just there for signature compatibility with {@link EventEmitter.on}.
     * @param listener The listener to add.
     */
    readonly on: (_eventName: typeof nodeInfoEventName, listener: () => void) => NodeInfo;

    /**
     * Removes the specified `listener` from the listener array for the event named "change".
     * @description Behaves exactly like {@link EventEmitter.off} with the exception that only listeners for the event
     * named `"change"` can be removed.
     * @param _eventName Always ignored, just there for signature compatibility with {@link EventEmitter.off}.
     * @param listener The listener to remove.
     */
    readonly off: (_eventName: typeof nodeInfoEventName, listener: () => void) => NodeInfo;
}

export interface NodeInfoArgs {
    /** Retrieve time-bound data up to this number of days in the past. */
    readonly days?: number;
}

/**
 * Gets information about the node.
 * @param args The authenticated LND API object, optionally combined with a number how far back historical data should
 * be retrieved. The default is 14 days.
 */
export const getNodeInfo = async (args: AuthenticatedLightningArgs<NodeInfoArgs>): Promise<NodeInfo> => {
    const { days = 14, ...lnd } = { ...args };
    const { after, before } = getRange(days);

    return new NodeInfoImpl(
        lnd,
        days,
        await getIdentity(lnd),
        await getChannels(lnd),
        await getSortedForwards(lnd, after, before),
        await getSortedPayments(lnd, after, before),
    );
};
