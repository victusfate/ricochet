[**@victusfate/ricochet v1.7.1**](../README.md)

***

[@victusfate/ricochet](../globals.md) / zeroFactorRow

# Function: zeroFactorRow()

> **zeroFactorRow**(`params`): [`FactorRow`](../interfaces/FactorRow.md)

Defined in: [scoring.ts:76](https://github.com/victusfate/ricochet/blob/05e1024558aa1ca4731aa49eeb4d4c7706ca9bcb/src/scoring.ts#L76)

Allocates a factor row of all zeros. Used for cold-start scoring:
`mfPredict(globalMean, zeroUser, itemFactor)` reduces to `globalMean + item.bias`.

## Parameters

### params

[`MfParams`](../interfaces/MfParams.md)

## Returns

[`FactorRow`](../interfaces/FactorRow.md)
