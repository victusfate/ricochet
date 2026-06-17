[**@victusfate/ricochet v2.0.0**](../README.md)

***

[@victusfate/ricochet](../globals.md) / mfLearnOne

# Function: mfLearnOne()

> **mfLearnOne**(`input`): `object`

Defined in: [scoring.ts:125](https://github.com/victusfate/ricochet/blob/main/src/scoring.ts#L125)

Performs one online SGD step of Biased Matrix Factorization.

Returns updated copies of `globalMean`, `n`, `user`, and `item` — inputs
are never mutated. Latent vectors are updated simultaneously (both gradients
are computed from the old vectors before either is applied).

## Parameters

### input

[`MfLearnInput`](../interfaces/MfLearnInput.md)

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
