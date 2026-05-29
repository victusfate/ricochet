[**@victusfate/ricochet v1.5.0**](../README.md)

***

[@victusfate/ricochet](../globals.md) / mfPredict

# Function: mfPredict()

> **mfPredict**(`globalMean`, `user`, `item`): `number`

Defined in: [scoring.ts:90](https://github.com/victusfate/ricochet/blob/41a11804dcf5b48c34e93617ead84c9de6a9679d/src/scoring.ts#L90)

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
