[**@victusfate/ricochet v1.10.0**](../README.md)

***

[@victusfate/ricochet](../globals.md) / newFactorRow

# Function: newFactorRow()

> **newFactorRow**(`params`): [`FactorRow`](../interfaces/FactorRow.md)

Defined in: [scoring.ts:65](https://github.com/victusfate/ricochet/blob/59ce69b73244814ea60961ffa3aff25bf8fadcaf/src/scoring.ts#L65)

Allocates a new factor row with bias 0 and latent vector initialised from
N(0, `params.sigmaInit`). Use for a freshly seen user or item.

## Parameters

### params

[`MfParams`](../interfaces/MfParams.md)

## Returns

[`FactorRow`](../interfaces/FactorRow.md)
