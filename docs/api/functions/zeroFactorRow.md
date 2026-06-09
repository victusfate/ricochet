[**@victusfate/ricochet v1.10.0**](../README.md)

***

[@victusfate/ricochet](../globals.md) / zeroFactorRow

# Function: zeroFactorRow()

> **zeroFactorRow**(`params`): [`FactorRow`](../interfaces/FactorRow.md)

Defined in: [scoring.ts:76](https://github.com/victusfate/ricochet/blob/2afee1925f887ec7721b493fa88dfe566672ea0d/src/scoring.ts#L76)

Allocates a factor row of all zeros. Used for cold-start scoring:
`mfPredict(globalMean, zeroUser, itemFactor)` reduces to `globalMean + item.bias`.

## Parameters

### params

[`MfParams`](../interfaces/MfParams.md)

## Returns

[`FactorRow`](../interfaces/FactorRow.md)
