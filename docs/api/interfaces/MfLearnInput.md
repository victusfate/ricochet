[**@victusfate/ricochet v2.1.2**](../README.md)

***

[@victusfate/ricochet](../globals.md) / MfLearnInput

# Interface: MfLearnInput

Defined in: [scoring.ts:104](https://github.com/victusfate/ricochet/blob/main/src/scoring.ts#L104)

Inputs to one online SGD step of Biased Matrix Factorization.

## Properties

### globalMean

> **globalMean**: `number`

Defined in: [scoring.ts:108](https://github.com/victusfate/ricochet/blob/main/src/scoring.ts#L108)

Current running mean of all observed ratings.

***

### item

> **item**: [`FactorRow`](FactorRow.md)

Defined in: [scoring.ts:114](https://github.com/victusfate/ricochet/blob/main/src/scoring.ts#L114)

Current item factor row.

***

### n

> **n**: `number`

Defined in: [scoring.ts:110](https://github.com/victusfate/ricochet/blob/main/src/scoring.ts#L110)

Number of ratings seen so far (before this one).

***

### params

> **params**: [`MfParams`](MfParams.md)

Defined in: [scoring.ts:106](https://github.com/victusfate/ricochet/blob/main/src/scoring.ts#L106)

Hyperparameters controlling learning rates, regularisation, and clipping.

***

### rating

> **rating**: `number`

Defined in: [scoring.ts:116](https://github.com/victusfate/ricochet/blob/main/src/scoring.ts#L116)

Observed rating for this (user, item) pair (see `ACTION_RATING`).

***

### user

> **user**: [`FactorRow`](FactorRow.md)

Defined in: [scoring.ts:112](https://github.com/victusfate/ricochet/blob/main/src/scoring.ts#L112)

Current user factor row.
