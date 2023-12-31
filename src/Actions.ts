// https://github.com/andreashuber69/lightning-node-operator/develop/README.md
import type { IChannelStats } from "./ChannelStats.js";
import { Change, InForward, InRebalance, OutForward } from "./ChannelStats.js";
import type { DeepReadonly } from "./DeepReadonly.js";
import { getDays } from "./info/getDays.js";
import { getMilliseconds } from "./info/getMilliseconds.js";
import type { YieldType } from "./lightning/YieldType.js";
import type { INodeStats } from "./NodeStats.js";

type Config = ActionsConfig & { readonly days: number };

const formatSats = (sats: number) => `${Math.round(sats).toLocaleString()}sats`;
const formatDaysAgo = (isoDate: string) => `${getDays(Date.now() - Date.parse(isoDate)).toFixed(1)} days ago`;

/**
 * Exposes various configuration variables that are used by {@linkcode Actions.get} to propose changes.
 * @description Some variables refer to the distance of the local balance from the target balance. This is a
 * normalized value to make algorithms independent from the channel capacity. A distance of 0 means that the local
 * balance is equal to the target balance. -1 signifies the local balance being 0, 1 means that the balance is equal
 * to the capacity of the channel. So, a value of -0.3 equates to the current balance being 30% less than the target.
 * However, a value of +0.3 means that the current balance is equal to the target balance + 30% of the (capacity -
 * target balance). This different calculation of negative and positive distance "automatically" introduces different
 * limits for channels with a target balance far below or above 50% of the capacity. For example, a channel with a
 * local target balance of 70% and {@linkcode ActionsConfig.minFeeIncreaseDistance} of 0.5 could have a local balance
 * varying between 35% and 85% without any fee increases ever being proposed.
 */
export interface ActionsConfig {
    /** The minimum number of past forwards routed through a channel to consider it as indicative for future flow. */
    readonly minChannelForwards: number;

    /**
     * The minimal fraction of the channel capacity that must be routed out to calculate the outgoing fee rate.
     * @description The current fee rate of a channel is sometimes probed with micro-payments of e.g. 1 satoshi with a
     * ridiculously high fee limit of say 50000ppm. The fees paid with such transactions are of course not indicative
     * of what normal network participants are willing to pay. The last out fee rate is therefore calculated as follows:
     * Take the last outgoing forwards that sum up to at least {@linkcode ActionsConfig.minOutFeeForwardFraction} times
     * the channel capacity and divide the total fees paid by the total forward amount. The resulting fee rate in PPM is
     * indicative of what real network participants were willing to pay. 0 means that only the latest outgoing forward
     * is considered (which is not recommended, see above). A value of 0.01 is probably sensible.
     */
    readonly minOutFeeForwardFraction: number;

    /**
     * The minimal balance a channel should have as a fraction of its capacity.
     * @description For example, 0.25 means that suggested actions will not let the local balance fall below 1/4 of the
     * channel capacity and not let it go above 3/4 (such that the remote balance will not fall below 1/4).
     */
    readonly minChannelBalanceFraction: number;

    /**
     * The minimum absolute distance from the target a channel or node balance can have before balance actions are
     * suggested. A value close to 0 means that rebalancing is proposed even if the target deviates very little (0
     * itself is not allowed as that equates to infinite priority for a difference of even 1 satoshi). 1 means that no
     * rebalancing is ever suggested. Values around 0.05 are probably sensible.
     */
    readonly minRebalanceDistance: number;

    /** The fraction to be added to the largest past forward to allow for even larger forwards in the future. */
    readonly largestForwardMarginFraction: number;

    /**
     * The minimum absolute distance from the target a channel balance must have before fee increase actions are
     * suggested. This value must be considerably larger than {@linkcode ActionsConfig.minRebalanceDistance}, so that
     * rebalancing is attempted before fee increases are proposed. A value close to 0 means that fee changes are
     * suggested even for small deviations from the target balance. 1 means that no fee increases are ever suggested.
     * Values around 0.4 are probably sensible. If the balance is below the target with `currentDistance` being the
     * current target balance distance and `feeRate` being the rate paid by the last outgoing forward, the new fee is
     * calculated as follows:
     *
     * ```
     * const newFeeRate = Math.round(feeRate * (1 + Math.abs(currentDistance) - minFeeIncreaseDistance));
     * ```
     *
     * For immediate fee increases (e.g. when an outgoing forward happened within the last few minutes), this new fee
     * rate is directly applied. When the last outgoing forward happened earlier, the fee is slowly increased depending
     * on the time passed since the forward, see {@linkcode ActionsConfig.feeIncreaseMultiplier}
     */
    readonly minFeeIncreaseDistance: number;

    /**
     * Determines how fast the fee is raised for long term fee increases. A value of 1 means that the calculated
     * fee rate (see {@linkcode ActionsConfig.minFeeIncreaseDistance}) is only suggested after
     * {@linkcode INodeStats.days} have passed since the last forward and linearly interpolated in between. A value of
     * a least 2 is probably sensible.
     */
    readonly feeIncreaseMultiplier: number;

    /**
     * The number of days a channel can be without outgoing forwards before fee decrease actions are suggested. Fee
     * decreases are always proposed linearly over the course of {@linkcode INodeStats.days} -
     * {@linkcode ActionsConfig.feeDecreaseWaitDays}.
     */
    readonly feeDecreaseWaitDays: number;

    /**
     * The minimal inflow expressed as a fraction of the total flow a channel must have for fee decreases to disregard
     * recent rebalance costs and the current partner fee rate. If the fraction is lower than this number, then the fee
     * rate is never lowered below recent rebalance costs or the current partner fee rate (whichever is higher). If the
     * fraction is higher than this number, the fee rate can potentially drop to zero. A value of at least 0.3 is
     * probably sensible.
     */
    readonly minInflowFraction: number;

    /** The maximum fee rate on a channel in PPM. */
    readonly maxFeeRate: number;
}

export interface Action {
    /** To what entity does this apply? */
    readonly entity: "channel" | "node";

    /** The standard id of the channel, if {@linkcode Action.entity} equals `"channel"`. */
    readonly id?: string;

    /** The alias of the channel partner (if set), if {@linkcode Action.entity} equals `"channel"`. */
    readonly alias?: string | undefined;

    /**
     * The priority of the action, the higher the number the sooner this action should be implemented. If the priority
     * equals 0, no action should be taken and the reason explains why.
     */
    readonly priority: number;

    /** The affected variable. */
    readonly variable: string;

    /** The current value of the variable. */
    readonly actual: number;

    /** The target value of the variable. */
    readonly target: number;

    /** The maximum value of the variable. */
    readonly max: number;

    /**
     * The reason why the action should be taken, if {@linkcode Action.priority} > 0. If {@linkcode Action.priority}
     * = 0, why no action is currently necessary.
     */
    readonly reason: string;
}

/**
 * Suggests actions for a routing LND node to get closer to profitability and avoid situations of low liquidity.
 * @description
 * The actions suggested by this class are made under the following <b>assumptions</b>:
 * <ul>
 * <li>No external data logging or storage is necessary, which means that actions are only ever calculated based on
 * historical data that can be retrieved from the node. For example, forwards and payments that happened in the last 30
 * days can be retrieved from LND via associated RPC functions. However, it is currently not possible to get an accurate
 * log of the fee rate on a given channel. Historical fee rates could be calculated from the fees that have been paid by
 * outgoing forwards, but doing so only works reliably when the base fee is constant, forwards never overpay fees and
 * the fee rate is never set externally. Obviously, especially the last condition is rarely met in reality, which is why
 * historical fee rates can only ever be <b>estimated</b>. For example, imagine a channel that has seen regular outgoing
 * forwards at a rate of 100ppm. At some point the human operator decides to raise the rate to 1000ppm, which will
 * obviously lead to an immediate drop of outgoing forwards. A week later the operator drops the fee rate back to 100ppm
 * and then looks at the actions proposed by {@linkcode Actions.get}. Since the code has no way of knowing that the rate
 * was much too high over the last 7 days, it will inevitably conclude that the sudden drop of outgoing flow calls for a
 * lower fee rate.</li>
 * <li>Actions are proposed based on long term data and on very recent events. For the former category,
 * this class produces consistent results even when consulted intermittently (e.g. once a day). Actions of the latter
 * category are only suggested if they happened in the last few minutes. For these immediate actions, it is thus
 * expected that {@linkcode Actions.get} is run with updated statistics immediately after each change and that the
 * actions are then executed immediately. Obviously, for this to work correctly, the clocks of the lightning node and
 * the computer calling {@linkcode Actions.get} must be in sync.</li>
 * <li>Base fees on all channels are assumed to remain constant. The currently set base fee is used to calculate the
 * rate paid by past forwards.</li>
 * <li>If there are past outgoing forwards for a channel, the fee rate paid by the last forward is assumed to have
 * been in effect up to the point when {@linkcode Actions.get} is run. If no outgoing forwards were made in the past
 * 30 days and the channel has been open for that length of time, this class can only suggest to either drop the fee
 * rate to zero or raise it to {@linkcode ActionsConfig.maxFeeRate} (depending on the current channel balance), due to
 * the fact that there is no way to determine whether the fee has been changed before, see above. Doing so will
 * encourage outflows or enable rebalancing. In both cases outgoing forwards will eventually materialize for most
 * channels. After that the regular fee algorithm will be able to change the fee more gradually.</li>
 * <li>Payments sent to or received from other nodes are neither expected to occur regularly nor is any attempt made to
 * anticipate them. While a single payment can skew fee calculation only in the short to medium term, regular
 * substantial payments will probably lower the profitability of the node.</li>
 * <li>With the exception of channels that did not ever see any outgoing forwards (see above), fees are always increased
 * or decreased relative to the fee rate paid by the last outgoing forward. For a fee increase, if the new fee target
 * happens to lie below the currently set fee rate, it is assumed that there is a good reason for the higher rate and
 * no action will be suggested. The opposite happens for fee decreases. These rules allow for human intervention and
 * also ensure that actions based on long term data will not interfere with immediate actions.</li>
 * <li>There is an ongoing effort to adjust channel balances to the given targets. Therefore, if a channel balance
 * stays substantially below the target for long periods of time, this is taken as an indicator that the fee rate on the
 * channel itself is too low for rebalancing to succeed. It is thus raised depending on how long the balance has been
 * staying below the target. On the other hand, if a channel balance stays substantially above the target for long, this
 * means that incoming flow was forwarded to channels with fees set too low. In order for rebalancing to work in the
 * opposite direction the fees on those channels should therefore be raised depending on how long the balance has been
 * staying above the target.</li>
 * </ul>
 * The actions are calculated as outlined below:
 * <ul>
 * <li>Observe incoming and outgoing flow of each channel and set the local balance target to optimize liquidity.
 * For example, very few channels have a good balance between incoming and outgoing forwards. It's much more likely for
 * a channel to have &gt;90% of its routing flow going out or coming in. For these channels it makes little sense to set
 * the balance target to half their capacity. On the other hand, it neither makes sense to target a local balance of
 * &gt;90% or &lt;10% (depending on flow direction), as doing so would preclude most routing in the other direction.
 * Such bidirectional routing is highly desirable (because it reduces rebalancing) and should therefore not be made
 * impossible by low liquidity. This is why the suggested actions will not let channel balance go below or above
 * {@linkcode ActionsConfig.minChannelBalanceFraction} (e.g. 25% and 75%).</li>
 * <li>Set the target of the total local balance of the node to the sum of the target balances of all channels.</li>
 * <li>Monitor individual channel balance. If the distance of the local balance to the target falls below
 * -{@linkcode ActionsConfig.minFeeIncreaseDistance}, this means that the fee on the channel itself is too low and
 * should therefore be raised. If channel balance raises above +{@linkcode ActionsConfig.minFeeIncreaseDistance}, this
 * means that incoming flow was forwarded to channels with fees too low and the fees on those channels should be raised.
 * </li>
 * <li>If the target balance distance stays above -{@linkcode ActionsConfig.minFeeIncreaseDistance} and no forwarding
 * flow is outgoing for more than {@linkcode ActionsConfig.feeDecreaseWaitDays}, this means that the fee on the channel
 * is too high and should be reduced slowly until it either reaches 0 or outgoing flow reduces the balance.</li>
 * </ul>
 * Note that the actions suggested by this class deliberately do not define how the targets should be reached. Some
 * targets can be trivially reached with automation (e.g. fees) others are much harder (e.g. individual channel
 * balances) or even even downright impossible to reach automatically (e.g. total node balance). An external component
 * should therefore define how these actions should be implemented.
 */
export class Actions {
    public constructor({ channels, days }: INodeStats, config: ActionsConfig) {
        this.config = { ...config, days };

        this.channels = new Map([...channels.values()].map(
            (channel) => ([channel, Actions.getChannelBalanceAction(channel, this.config)]),
        ));
    }

    public *get() {
        let actual = 0;
        let target = 0;
        let max = 0;

        for (const balanceAction of this.channels.values()) {
            actual += balanceAction.actual;
            target += balanceAction.target;
            max += balanceAction.max;
            yield* Actions.filterBalanceAction(balanceAction);
        }

        const distance = Actions.getTargetBalanceDistance(actual, target, max);
        const priority = Actions.getPriority(4, distance, this.config.minRebalanceDistance);
        const reason = "This is the sum of the target balances of all channels.";
        const action = { entity: "node", variable: "balance", priority, actual, target, max, reason } as const;
        yield* Actions.filterBalanceAction(action);
        yield* this.getFeeActions();
    }

    private static getChannelBalanceAction(channel: IChannelStats, config: Config): Action {
        const { properties, inForwards, outForwards } = channel;
        const { id, partnerAlias: alias, capacity, local_balance: actual } = properties;

        const {
            minChannelBalanceFraction, minRebalanceDistance, minChannelForwards, largestForwardMarginFraction, days,
        } = config;

        const createAction = (targetBalance: number, reason: string): Action => {
            const target = Math.round(targetBalance);
            const distance = this.getTargetBalanceDistance(actual, target, capacity);
            const priority = this.getPriority(1, distance, minRebalanceDistance);
            const max = capacity;
            return { entity: "channel", id, alias, priority, variable: "balance", actual, target, max, reason };
        };

        const optimalBalance =
            Math.round(outForwards.totalTokens / (inForwards.totalTokens + outForwards.totalTokens) * capacity);

        if (Number.isNaN(optimalBalance) || inForwards.count + outForwards.count < minChannelForwards) {
            return createAction(
                0.5 * capacity,
                `There are fewer forwards (${inForwards.count + outForwards.count}) than required ` +
                `(${minChannelForwards}) to predict future flow, defaulting to half the capacity.`,
            );
        }

        const largestForwardMarginMultiplier = (1 + largestForwardMarginFraction);
        // What minimum balance do we need to have in the channel to accommodate the largest outgoing forward?
        // To accommodate still larger future forwards, we apply the multiplier.
        const minLargestForwardBalance = Math.round(outForwards.maxTokens * largestForwardMarginMultiplier);
        // What maximum balance can we have in the channel to accommodate the largest incoming forward? To
        // accommodate still larger future forwards, we apply the multiplier.
        const maxLargestForwardBalance = Math.round(capacity - (inForwards.maxTokens * largestForwardMarginMultiplier));
        const marginPercent = Math.round(largestForwardMarginFraction * 100);

        const formatted = {
            maxInTokens: formatSats(inForwards.maxTokens),
            maxOutTokens: formatSats(outForwards.maxTokens),
            capacity: formatSats(capacity),
            totalInTokens: formatSats(inForwards.totalTokens),
            totalOutTokens: formatSats(outForwards.totalTokens),
            optimalBalance: formatSats(optimalBalance),
        } as const;

        if (minLargestForwardBalance > maxLargestForwardBalance) {
            // TODO: "Increase" the channel capacity?
            return createAction(
                0.5 * capacity,
                `The sum of the largest incoming (${formatted.maxInTokens}) and outgoing (${formatted.maxOutTokens}) ` +
                `forwards + ${marginPercent}% exceeds the capacity of ${formatted.capacity}, defaulting to half the ` +
                "capacity.",
            );
        }

        const flowStats =
            `In the last ${days} days this channel has seen total incoming forwards of ${formatted.totalInTokens} ` +
            `and total outgoing forwards of ${formatted.totalOutTokens}.`;

        const minBalance = Math.round(minChannelBalanceFraction * capacity);

        if (optimalBalance < minBalance) {
            return createAction(
                minBalance,
                `${flowStats} The optimal balance according to flow (${formatted.optimalBalance}) is below the ` +
                "minimum balance.",
            );
        }

        const maxBalance = capacity - minBalance;

        if (optimalBalance > maxBalance) {
            return createAction(
                maxBalance,
                `${flowStats} The optimal balance according to flow (${formatted.optimalBalance}) is above the ` +
                "maximum balance.",
            );
        }

        if (optimalBalance < minLargestForwardBalance) {
            // TODO: "Increase" the channel capacity?
            return createAction(
                minLargestForwardBalance,
                `${flowStats} The optimal balance according to flow (${formatted.optimalBalance}) is below the ` +
                ` minimum balance to route the largest past outgoing forward of ${formatted.maxOutTokens} ` +
                `+ ${marginPercent}%.`,
            );
        }

        if (optimalBalance > maxLargestForwardBalance) {
            // TODO: "Increase" the channel capacity?
            return createAction(
                maxLargestForwardBalance,
                `${flowStats} The optimal balance according to flow (${formatted.optimalBalance}) is above the ` +
                `maximum balance to route the largest past incoming forward of ${formatted.maxInTokens} ` +
                `+ ${marginPercent}%.`,
            );
        }

        return createAction(optimalBalance, `${flowStats} This is the optimal balance according to flow.`);
    }

    private static *filterBalanceAction(action: Action) {
        if (action.priority > 0) {
            yield action;
        }
    }

    private static getTargetBalanceDistance(balance: number, target: number, capacity: number) {
        return balance <= target ? (balance / target) - 1 : (balance - target) / (capacity - target);
    }

    private static getPriority(base: number, distance: number, minRebalanceDistance: number) {
        return base * Math.floor(Math.abs(distance) / minRebalanceDistance);
    }

    // Provides the already filtered history relevant to choose a new fee for the given channel.
    private static *filterHistory<T extends Change>(
        history: DeepReadonly<Change[]>,
        ctor: abstract new (...args: never[]) => T,
        done?: (change: Readonly<Change>) => boolean,
    ): Generator<Readonly<T>, void> {
        for (const change of history) {
            if (done?.(change)) {
                return;
            } else if (change instanceof ctor) {
                yield change;
            }
        }
    }

    private static getFeeRate(fee: number, amount: number) {
        return Math.round(fee / Math.abs(amount) * 1_000_000);
    }

    private readonly config: Config;
    private readonly channels: ReadonlyMap<IChannelStats, Action>;

    // eslint-disable-next-line @typescript-eslint/naming-convention
    private getLastOutFeeRate({ properties: { capacity, base_fee }, history }: IChannelStats) {
        const minAmount = capacity * this.config.minOutFeeForwardFraction;
        let total = 0;
        const done = (c: Readonly<Change>) => c instanceof OutForward && (total += c.amount) >= minAmount + c.amount;
        const forwards = [...Actions.filterHistory(history, OutForward, done)];

        if (total >= minAmount) {
            const baseFees = forwards.length * base_fee;
            return Actions.getFeeRate(
                forwards.reduce((p, c) => p + c.fee, 0) - baseFees,
                forwards.reduce((p, c) => p + c.amount, 0),
            );
        }

        return undefined;
    }

    private *getFeeActions() {
        for (const channel of this.channels.keys()) {
            yield* this.getFeeAction(channel);
        }
    }

    private *getFeeAction(channel: IChannelStats) {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        const { properties: { fee_rate, id }, history } = channel;
        const { value: lastOut } = Actions.filterHistory(history, OutForward).next();
        const lastOutFeeRate = this.getLastOutFeeRate(channel);
        const currentDistance = this.getCurrentDistance(channel);
        const { minRebalanceDistance, minFeeIncreaseDistance, maxFeeRate } = this.config;
        const isBelowBounds = currentDistance <= -minFeeIncreaseDistance;

        const getIncreaseAction = (partialHistory: DeepReadonly<Change[]>, timeMilliseconds: number) => {
            const done = (c: Readonly<Change>) => this.getDistance(channel, c.balance) > -minFeeIncreaseDistance;
            const belowOutForwards = [...Actions.filterHistory(partialHistory, OutForward, done)] as const;

            if (!partialHistory[0] || !belowOutForwards[0]) {
                throw new Error(`Unexpected empty history or no outgoing forwards found for channel ${id}!`);
            }

            const distance = this.getDistance(channel, partialHistory[0].balance);
            return this.getMaxIncreaseFeeAction(channel, distance, belowOutForwards, timeMilliseconds);
        };

        if (lastOut && lastOutFeeRate) {
            if (isBelowBounds) {
                const action = getIncreaseAction(history, Date.now());

                if (action.target > fee_rate) {
                    yield action;
                }
            } else {
                const done = (c: Readonly<Change>) => this.getDistance(channel, c.balance) <= -minFeeIncreaseDistance;
                const notBelowChanges = [...Actions.filterHistory(history, Change, done)] as const;
                const notBelowStart = notBelowChanges.at(-1)?.time ?? "";

                if (notBelowStart > lastOut.time) {
                    // There has been no outgoing forward since the balance has moved out of the below bounds zone,
                    // which forces us recalculate the fee rate that was proposed at that point and then calculate fee
                    // decreases from there.
                    const { target: feeRate } =
                        getIncreaseAction(history.slice(notBelowChanges.length), Date.parse(notBelowStart));

                    if (yield* this.getRebalancedFeeDecreaseAction(channel, currentDistance, feeRate, notBelowStart)) {
                        return;
                    }
                } else if (yield* this.getFeeDecreaseAction(channel, currentDistance, lastOut, lastOutFeeRate)) {
                    // The latest outgoing forward happened after the balance moved out of the below bounds zone and a
                    // fee decrease was proposed.
                    return;
                }

                // Potentially raising the fee due to forwards coming in through channels that are above bounds only
                // makes sense if this channel itself is at least as much below the target balance such that it will
                // be targeted by rebalancing.
                if (currentDistance <= -minRebalanceDistance) {
                    const allOut = [...Actions.filterHistory(history, OutForward)] as const;
                    yield* this.getAboveBoundsFeeIncreaseAction(channel, lastOutFeeRate, allOut);
                }
            }
        } else {
            // TODO: Take rebalancing cost as a reasonable estimate for a fee starting point
            const newFeeRate = isBelowBounds ? maxFeeRate : 0;

            if (fee_rate !== newFeeRate) {
                yield* this.getNoForwardsFeeAction(channel, currentDistance, newFeeRate);
            }
        }
    }

    private getMaxIncreaseFeeAction(
        channel: IChannelStats,
        currentDistance: number,
        forwards: DeepReadonly<OutForward[]>,
        timeMilliseconds: number,
    ) {
        // For all changes that pushed the target balance distance below bounds, we calculate the resulting fee
        // increase. In the end we choose the highest fee increase. This approach guarantees that we do the "right
        // thing", even when there are conflicting increases from "emergency" measures and long term measures. For
        // example, a channel could have had a balance slightly below the minimum for two weeks when another
        // outgoing forward reduces the balance slightly more. When this code is run immediately afterwards, it will
        // produce two fee increases. An "emergency" one (designed to curb further outflow) and a long term one,
        // which is designed to slowly raise the fee to the point where rebalances are able to increase outgoing
        // liquidity. In this case it is likely that the long term fee increase is higher than the immediate one. On
        // the other hand, when the time span between the two outgoing forwards is much shorter, it is likely that
        // the immediate fee increase is higher.
        const getIncreaseFeeAction = (change: Readonly<OutForward>) => {
            const feeRate = Actions.getFeeRate(change.fee - channel.properties.base_fee, change.amount);
            const elapsedMilliseconds = timeMilliseconds - Date.parse(change.time);
            const rawFraction = Math.abs(currentDistance) - this.config.minFeeIncreaseDistance;
            const addFraction = this.getIncreaseFraction(elapsedMilliseconds, rawFraction);
            // If the fee rate has been really low then the formula wouldn't increase it meaningfully. An
            // increase to at least 30 seems like a good idea.
            const newFeeRate = Math.min(Math.max(Math.round(feeRate * (1 + addFraction)), 30), this.config.maxFeeRate);

            const reason =
                `The current distance from the target balance is ${currentDistance.toFixed(2)} and the outgoing ` +
                `forward ${formatDaysAgo(change.time)} contributed to that situation and paid ${feeRate}ppm.`;

            return this.createFeeAction(channel, newFeeRate, reason);
        };

        const actions = forwards.map((forward) => getIncreaseFeeAction(forward));
        return actions.reduce((p, c) => (p.target > c.target ? p : c));
    }

    private *getRebalancedFeeDecreaseAction(
        channel: IChannelStats,
        currentDistance: number,
        feeRate: number,
        notBelowStart: string,
    ) {
        const reason =
            `The current distance from the target balance is ${currentDistance.toFixed(2)} and there have been no ` +
            "outgoing forwards since the balance has moved out of the below bounds zone " +
            `${formatDaysAgo(notBelowStart)}. At that point the proposed fee rate was ${feeRate}ppm.`;

        return yield* this.createFeeDecreaseAction(channel, feeRate, Date.now() - Date.parse(notBelowStart), reason);
    }

    private *getFeeDecreaseAction(
        channel: IChannelStats,
        currentDistance: number,
        lastOut: Readonly<OutForward>,
        lastOutFeeRate: number,
    ) {
        const reason =
            `The current distance from the target balance is ${currentDistance.toFixed(2)}, the most recent outgoing ` +
            `forwards adding to at least ${channel.properties.capacity * this.config.minOutFeeForwardFraction}sats ` +
            `took place ${formatDaysAgo(lastOut.time)} and paid an average of ${lastOutFeeRate}ppm.`;

        return yield* this.createFeeDecreaseAction(
            channel,
            lastOutFeeRate,
            Date.now() - Date.parse(lastOut.time),
            reason,
        );
    }

    private *getAboveBoundsFeeIncreaseAction(
        channel: IChannelStats,
        lastOutFeeRate: number,
        allOut: DeepReadonly<OutForward[]>,
    ) {
        // For any channel with outgoing forwards, it is possible that the majority of the outgoing flow is
        // coming from channels with a balance above bounds. Apparently, ongoing efforts at rebalancing
        // (see assumptions) are unable to rebalance this excess balance back into this channel, which means
        // that the fee for this channel is too low.
        const inChannels = [...new Set(allOut.map((f) => f.inChannel))].
            // False positive, this is a user-defined type guard.
            // eslint-disable-next-line unicorn/prefer-native-coercion-functions
            filter(<T extends NonNullable<unknown>>(c: T | undefined): c is T => Boolean(c));

        const inflowStats = [...this.getAllAboveBoundsInflowStats(channel, inChannels)] as const;

        if (inflowStats.length > 0) {
            const earliestIsoTime = new Date(Math.min(...inflowStats.map((i) => i.earliest))).toISOString();
            const weightedAboveBoundsInflow = inflowStats.map((i) => i.channel * i.currentDistance);

            const totalOutflow =
                allOut.filter((f) => f.time >= earliestIsoTime).reduce((p, c) => p + c.amount, 0);

            // When all above bounds inflow of a single channel went out through this channel and this channel had
            // no other outflows, the following fraction can be as low as config.minFeeIncreaseDistance (because the
            // inflow is weighted with the current target balance distance of the incoming channel). When the
            // balance of the incoming channel is as close to the capacity as possible, the fraction will approach 1.
            const fraction = weightedAboveBoundsInflow.reduce((p, c) => p + c) / totalOutflow;

            if (fraction > this.config.minFeeIncreaseDistance) {
                // We only increase the fee to degree that the total outflows in this channel were caused by
                // incoming forwards into above bounds channels and the current target balance distance.
                const increaseFraction =
                    (fraction - this.config.minFeeIncreaseDistance) * Math.abs(this.getCurrentDistance(channel));

                const newFeeRate =
                    Math.min(Math.round(lastOutFeeRate * (1 + increaseFraction)), this.config.maxFeeRate);

                if (newFeeRate > channel.properties.fee_rate) {
                    const aboveBoundsInflow = inflowStats.map((i) => i.channel).reduce((p, c) => p + c);
                    const formattedStats = inflowStats.map((i) => this.getChannelStats(i, totalOutflow)).join("\n");

                    const reason =
                        `Total forwards of ${formatSats(aboveBoundsInflow)} incoming from above bounds channels ` +
                        `contributed to the total outflow from this channel as follows:\n${formattedStats}`;

                    yield this.createFeeAction(channel, newFeeRate, reason);
                }
            }
        }
    }

    private *getNoForwardsFeeAction(channel: IChannelStats, currentDistance: number, feeRate: number) {
        if (Date.now() - Date.parse(channel.properties.openedAt) >= getMilliseconds(this.config.days)) {
            const reason =
                `The current distance from the target balance is ${currentDistance.toFixed(2)} and less than ` +
                `${this.config.minOutFeeForwardFraction * channel.properties.capacity}sats of outgoing forwards ` +
                `have been observed in the last ${this.config.days} days.`;

            yield this.createFeeAction(channel, feeRate, reason);
        }
    }

    private getIncreaseFraction(elapsedMilliseconds: number, rawFraction: number) {
        const isRecent = elapsedMilliseconds < 5 * 60 * 1000;
        const elapsedDays = getDays(elapsedMilliseconds) * this.config.feeIncreaseMultiplier;
        return isRecent ? rawFraction : rawFraction * elapsedDays / this.config.days;
    }

    private createFeeAction(channel: IChannelStats, target: number, reason: string): Action {
        const { properties: { id, partnerAlias: alias, fee_rate: actual } } = channel;
        const max = this.config.maxFeeRate;
        return { entity: "channel", id, alias, priority: 1, variable: "feeRate", actual, target, max, reason };
    }

    private *createFeeDecreaseAction(
        channel: IChannelStats,
        feeRate: number,
        elapsedMilliseconds: number,
        reason: string,
    ) {
        const elapsedDays = getDays(elapsedMilliseconds) - this.config.feeDecreaseWaitDays;

        if (elapsedDays > 0) {
            const decreaseFraction = elapsedDays / (this.config.days - this.config.feeDecreaseWaitDays);
            const newFeeRate = Math.round(feeRate * (1 - decreaseFraction));
            const { minFeeRate, minReason } = this.getMinFeeRate(channel, reason);
            yield* this.checkCreateAction(channel, Math.max(minFeeRate, newFeeRate), minReason);
            return true;
        }

        return false;
    }

    private *getAllAboveBoundsInflowStats(outChannel: IChannelStats, inChannels: readonly IChannelStats[]) {
        for (const inChannel of inChannels) {
            yield* this.getAboveBoundsInflowStats(outChannel, inChannel);
        }
    }

    private getChannelStats(
        { name, currentDistance, earliest, latest, channel }: YieldType<typeof this.getAboveBoundsInflowStats>,
        totalOutflow: number,
    ) {
        return `${name}: ${currentDistance.toFixed(2)} ${Math.round(channel / totalOutflow * 100)}% ` +
            `(${new Date(earliest).toISOString()} - ${new Date(latest).toISOString()})`;
    }

    private getMinFeeRate(channel: IChannelStats, reason: string) {
        const { inForwards, outForwards, history, properties: { partnerFeeRate } } = channel;

        const getAverageRebalanceRate = () => {
            let count = 0;
            const done = (c: Readonly<Change>) => c instanceof InRebalance && ++count === 3;

            const minRebalanceRates = [...Actions.filterHistory(history, InRebalance, done)].
                map((r) => Actions.getFeeRate(r.fee, r.amount));

            return minRebalanceRates.reduce((p, c) => p + c, 0) / minRebalanceRates.length;
        };

        const rebalanceRate = getAverageRebalanceRate();

        if (!Number.isFinite(rebalanceRate)) {
            return {
                minFeeRate: 0,
                minReason:
                    `${reason} No rebalance in transactions were necessary in the last ${this.config.days} days` +
                    ", so the lowest sensible fee rate is 0.",
            } as const;
        }

        const inflowFraction = inForwards.totalTokens / (outForwards.totalTokens + inForwards.totalTokens);

        // The rebalance rate (or partner fee rate) should only be taken as a lower bound for the fee rate if the inflow
        // fraction is below the minimum fraction. Otherwise, we should be able to set the fee rate such that an
        // equilibrium is reached.
        if (!Number.isFinite(inflowFraction) || (inflowFraction > this.config.minInflowFraction)) {
            return {
                minFeeRate: 0,
                minReason:
                    `${reason} In the last ${this.config.days} days, the inflow fraction of the total flow was ` +
                    `above the minimum of ${this.config.minInflowFraction}, so the lowest sensible fee rate is 0.`,
            } as const;
        }

        const realPartnerFeeRate = partnerFeeRate ?? 0;

        const reasonPrefix =
            `${reason} With a inflow fraction of ${inflowFraction.toFixed(2)} of the total flow and the necessity of ` +
            `rebalancing in the last ${this.config.days} days, the lowest sensible fee rate is the `;

        if (rebalanceRate >= realPartnerFeeRate) {
            return {
                minFeeRate: rebalanceRate,
                minReason: `${reasonPrefix}average of ${rebalanceRate}ppm paid for the most recent in rebalances.`,
            } as const;
        }

        return {
            minFeeRate: realPartnerFeeRate,
            minReason:
                `${reasonPrefix}partner fee rate of ${realPartnerFeeRate}ppm (which is currently higher than the ` +
                "fee rate paid for most recent rebalances).",
        } as const;
    }

    private *checkCreateAction(channel: IChannelStats, newFeeRate: number, newReason: string) {
        if (newFeeRate < channel.properties.fee_rate) {
            yield this.createFeeAction(channel, newFeeRate, newReason);
        }
    }

    private *getAboveBoundsInflowStats(forOutChannel: IChannelStats, inChannel: IChannelStats) {
        const currentDistance = this.getCurrentDistance(inChannel);

        if (currentDistance >= this.config.minFeeIncreaseDistance) {
            const done =
                (c: Readonly<Change>) => this.getDistance(inChannel, c.balance) < this.config.minFeeIncreaseDistance;

            const { history, properties: { id, partnerAlias: rawAlias } } = inChannel;
            let earliest = Date.now();
            let latest = 0;
            let channel = 0;

            for (const { time, amount, outChannel } of Actions.filterHistory(history, InForward, done)) {
                if (outChannel === forOutChannel) {
                    const timeMilliseconds = Date.parse(time);
                    earliest = Math.min(earliest, timeMilliseconds);
                    latest = Math.max(latest, timeMilliseconds);

                    // Amounts of incoming forwards are always negative.
                    channel -= amount;
                }
            }

            if (latest !== 0) {
                const aliasMax = 30;
                const alias = (rawAlias?.length ?? 0) > aliasMax ? `${rawAlias?.slice(0, aliasMax - 3)}...` : rawAlias;
                const idMax = 14;
                const name = `${id.padStart(idMax)} ${`(${alias})`.padEnd(aliasMax + 2)}`;
                yield { name, currentDistance, earliest, latest, channel } as const;
            }
        }
    }

    private getCurrentDistance(channel: IChannelStats) {
        return this.getDistance(channel, channel.properties.local_balance);
    }

    private getDistance(channel: IChannelStats, balance: number) {
        const { target } = this.channels.get(channel) ?? {};

        if (!target) {
            throw new Error("Channel not found!");
        }

        return Actions.getTargetBalanceDistance(balance, target, channel.properties.capacity);
    }
}
