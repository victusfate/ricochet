[**@victusfate/ricochet v1.6.0**](../README.md)

***

[@victusfate/ricochet](../globals.md) / mfLearnOne

# Function: mfLearnOne()

> **mfLearnOne**(`params`, `globalMean`, `n`, `user`, `item`, `rating`): `object`

Defined in: [scoring.ts:115](https://github.com/victusfate/ricochet/blob/6529db6ce6df22d258291217fe235fa0e8623954/src/scoring.ts#L115)

Performs one online SGD step of Biased Matrix Factorization.

Returns updated copies of `globalMean`, `n`, `user`, and `item` — inputs
are never mutated. Latent vectors are updated simultaneously (both gradients
are computed from the old vectors before either is applied).

## Parameters

### params

[`MfParams`](../interfaces/MfParams.md)

Hyperparameters controlling learning rates, regularisation, and clipping.

### globalMean

`number`

Current running mean of all observed ratings.

### n

`number`

Number of ratings seen so far (before this one).

### user

[`FactorRow`](../interfaces/FactorRow.md)

Current user factor row.

### item

[`FactorRow`](../interfaces/FactorRow.md)

Current item factor row.

### rating

`number`

Observed rating for this (user, item) pair (see `ACTION_RATING`).

## Returns

`object`

`{ globalMean, n, user, item }` — updated state after one SGD step.

### globalMean

> **globalMean**: `number`

### item

> **item**: [`FactorRow`](../interfaces/FactorRow.md)

### n

> **n**: `number`

### user

> **user**: [`FactorRow`](../interfaces/FactorRow.md)
