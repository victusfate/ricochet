[**@victusfate/ricochet v1.7.1**](../README.md)

***

[@victusfate/ricochet](../globals.md) / mfPredict

# Function: mfPredict()

> **mfPredict**(`globalMean`, `user`, `item`): `number`

Defined in: [scoring.ts:90](https://github.com/victusfate/ricochet/blob/05e1024558aa1ca4731aa49eeb4d4c7706ca9bcb/src/scoring.ts#L90)

Computes the BiasedMF predicted score for a (user, item) pair.

Formula: `ŷ = globalMean + user.bias + item.bias + dot(user.v, item.v)`

## Parameters

### globalMean

`number`

Running mean of all observed ratings.

### user

[`FactorRow`](../interfaces/FactorRow.md)

Learned user factor row (`bias` + latent vector `v`).

### item

[`FactorRow`](../interfaces/FactorRow.md)

Learned item factor row (`bias` + latent vector `v`).

## Returns

`number`

Predicted rating (unbounded float).
