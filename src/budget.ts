/**
 * The per-process spend total, checked before anything is signed.
 *
 * A call RESERVES its ceiling before it starts, and the ceiling handed to the
 * signer is what was reserved. Two calls running at once therefore cannot
 * both fit under the same remaining total: the second reserves only what the
 * first left. When the call ends, whatever it did not sign goes back.
 *
 * Spend is counted when the authorization is SIGNED, not when a 200 comes
 * back. Under `exact` the seller can settle a signature whose answer never
 * arrived, so a timeout after signing is money the payer must assume is gone.
 */

export class BudgetExhausted extends Error {
  constructor(
    readonly remaining: bigint,
    readonly total: bigint,
  ) {
    super(
      `The spend limit for this session is used up: ${remaining} of ${total} atomic units remain. ` +
        'Nothing was signed. Raise POCKET_MAX_TOTAL_ATOMIC and restart the server to spend more.',
    );
    this.name = 'BudgetExhausted';
  }
}

export interface Reservation {
  /** The most this call may sign for: min(per-call ceiling, what was left). */
  readonly ceiling: bigint;
  /** Record a signed authorization. At most once; never above the ceiling. */
  commit(amount: bigint): void;
  /** Return the unsigned part of the reservation. Idempotent. */
  release(): void;
}

export class Budget {
  #remaining: bigint;
  #spent = 0n;

  constructor(readonly total: bigint) {
    this.#remaining = total;
  }

  get spent(): bigint {
    return this.#spent;
  }

  get remaining(): bigint {
    return this.#remaining;
  }

  reserve(perCallCeiling: bigint): Reservation {
    const ceiling = perCallCeiling < this.#remaining ? perCallCeiling : this.#remaining;
    if (ceiling <= 0n) throw new BudgetExhausted(this.#remaining, this.total);
    this.#remaining -= ceiling;

    let committed: bigint | undefined;
    let released = false;
    return {
      ceiling,
      commit: (amount: bigint) => {
        if (committed !== undefined) throw new Error('A reservation is committed once.');
        // The signer's own ceiling check makes this unreachable; asserted anyway,
        // because a budget that silently absorbs an overrun is not a budget.
        if (amount > ceiling) throw new Error(`Signed ${amount}, above the reserved ${ceiling}.`);
        committed = amount;
        this.#spent += amount;
      },
      release: () => {
        if (released) return;
        released = true;
        this.#remaining += ceiling - (committed ?? 0n);
      },
    };
  }
}
