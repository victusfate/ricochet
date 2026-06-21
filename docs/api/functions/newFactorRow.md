[**@victusfate/ricochet v2.1.2**](../README.md)

***

[@victusfate/ricochet](../globals.md) / newFactorRow

# Function: newFactorRow()

> **newFactorRow**(`params`): [`FactorRow`](../interfaces/FactorRow.md)

Defined in: [scoring.ts:67](https://github.com/victusfate/ricochet/blob/main/src/scoring.ts#L67)

Allocates a new factor row with bias 0 and latent vector initialised from
N(0, `params.sigmaInit`). Use for a freshly seen user or item.

## Parameters

### params

[`MfParams`](../interfaces/MfParams.md)

## Returns

[`FactorRow`](../interfaces/FactorRow.md)
