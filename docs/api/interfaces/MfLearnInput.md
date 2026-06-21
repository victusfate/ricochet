[**@victusfate/ricochet v2.1.2**](../README.md)

***

[@victusfate/ricochet](../globals.md) / MfLearnInput

# Interface: MfLearnInput

Defined in: [scoring.ts:103](https://github.com/victusfate/ricochet/blob/main/src/scoring.ts#L103)

Inputs to one online SGD step of Biased Matrix Factorization.

## Properties

### globalMean

> **globalMean**: `number`

Defined in: [scoring.ts:107](https://github.com/victusfate/ricochet/blob/main/src/scoring.ts#L107)

Current running mean of all observed ratings.

***

### item

> **item**: [`FactorRow`](FactorRow.md)

Defined in: [scoring.ts:113](https://github.com/victusfate/ricochet/blob/main/src/scoring.ts#L113)

Current item factor row.

***

### n

> **n**: `number`

Defined in: [scoring.ts:109](https://github.com/victusfate/ricochet/blob/main/src/scoring.ts#L109)

Number of ratings seen so far (before this one).

***

### params

> **params**: [`MfParams`](MfParams.md)

Defined in: [scoring.ts:105](https://github.com/victusfate/ricochet/blob/main/src/scoring.ts#L105)

Hyperparameters controlling learning rates, regularisation, and clipping.

***

### rating

> **rating**: `number`

Defined in: [scoring.ts:115](https://github.com/victusfate/ricochet/blob/main/src/scoring.ts#L115)

Observed rating for this (user, item) pair (see `ACTION_RATING`).

***

### user

> **user**: [`FactorRow`](FactorRow.md)

Defined in: [scoring.ts:111](https://github.com/victusfate/ricochet/blob/main/src/scoring.ts#L111)

Current user factor row.
