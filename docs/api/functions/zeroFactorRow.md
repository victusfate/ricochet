[**@victusfate/ricochet v1.4.2**](../README.md)

***

[@victusfate/ricochet](../globals.md) / zeroFactorRow

# Function: zeroFactorRow()

> **zeroFactorRow**(`params`): [`FactorRow`](../interfaces/FactorRow.md)

Defined in: scoring.ts:76

Allocates a factor row of all zeros. Used for cold-start scoring:
`mfPredict(globalMean, zeroUser, itemFactor)` reduces to `globalMean + item.bias`.

## Parameters

### params

[`MfParams`](../interfaces/MfParams.md)

## Returns

[`FactorRow`](../interfaces/FactorRow.md)
