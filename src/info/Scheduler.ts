// https://github.com/andreashuber69/lightning-node-operator/develop/README.md
import { EventEmitter } from "node:events";

/** Schedules calls to occur after a given delay. */
export class Scheduler {
    public constructor(public readonly delayMilliseconds = 10_000) {
        if (typeof this.delayMilliseconds !== "number" || this.delayMilliseconds <= 0) {
            throw new Error(`delayMilliseconds is invalid: ${delayMilliseconds}.`);
        }
    }

    /**
     * If idle, schedules a call to the passed function.
     * @description Right after construction, an object of this class is in the idle state. When called in this state,
     * the state changes to busy, a call to the passed function is scheduled to occur after
     * {@linkcode Scheduler.delayMilliseconds} and {@linkcode Scheduler.call} then returns immediately. The state only
     * changes back to idle after the `func` has been called and the result awaited. When called in the busy state,
     * {@linkcode Scheduler.call} returns right away without doing anything.
     * @param func The function to call.
     */
    public call(func: () => unknown) {
        if (this.idle) {
            void this.delay(func);
        }
    }

    public onError(listener: (error: unknown) => void) {
        this.errorEmitter.on(Scheduler.eventName, listener);
    }

    public removeAllListeners() {
        this.errorEmitter.removeAllListeners();
    }

    ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    private static readonly eventName = "error";

    private idle = true;
    // eslint-disable-next-line unicorn/prefer-event-target
    private readonly errorEmitter = new EventEmitter();

    private async delay(func: () => unknown) {
        this.idle = false;

        try {
            await new Promise((resolve) => setTimeout(resolve, this.delayMilliseconds));
            await func();
        } catch (error: unknown) {
            this.errorEmitter.emit(Scheduler.eventName, error);
        } finally {
            this.idle = true;
        }
    }
}
