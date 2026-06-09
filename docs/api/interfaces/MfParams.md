[**@victusfate/ricochet v1.10.0**](../README.md)

***

[@victusfate/ricochet](../globals.md) / MfParams

# Interface: MfParams

Defined in: [scoring.ts:18](https://github.com/victusfate/ricochet/blob/59ce69b73244814ea60961ffa3aff25bf8fadcaf/src/scoring.ts#L18)

Hyperparameters for the Biased Matrix Factorization model.

## Properties

### clipError

> **clipError**: `number`

Defined in: [scoring.ts:30](https://github.com/victusfate/ricochet/blob/59ce69b73244814ea60961ffa3aff25bf8fadcaf/src/scoring.ts#L30)

Clips the residual error before gradient computation to prevent runaway updates. Default: 10.

***

### l2Bias

> **l2Bias**: `number`

Defined in: [scoring.ts:26](https://github.com/victusfate/ricochet/blob/59ce69b73244814ea60961ffa3aff25bf8fadcaf/src/scoring.ts#L26)

L2 regularisation coefficient for biases (0 = no regularisation). Default: 0.

***

### l2Latent

> **l2Latent**: `number`

Defined in: [scoring.ts:28](https://github.com/victusfate/ricochet/blob/59ce69b73244814ea60961ffa3aff25bf8fadcaf/src/scoring.ts#L28)

L2 regularisation coefficient for latent vectors. Default: 0.05.

***

### lrBias

> **lrBias**: `number`

Defined in: [scoring.ts:22](https://github.com/victusfate/ricochet/blob/59ce69b73244814ea60961ffa3aff25bf8fadcaf/src/scoring.ts#L22)

Learning rate for bias terms. Default: 0.05.

***

### lrLatent

> **lrLatent**: `number`

Defined in: [scoring.ts:24](https://github.com/victusfate/ricochet/blob/59ce69b73244814ea60961ffa3aff25bf8fadcaf/src/scoring.ts#L24)

Learning rate for latent factor vectors. Default: 0.05.

***

### nFactors

> **nFactors**: `number`

Defined in: [scoring.ts:20](https://github.com/victusfate/ricochet/blob/59ce69b73244814ea60961ffa3aff25bf8fadcaf/src/scoring.ts#L20)

Number of latent factors per user/item vector. Default: 10.

***

### sigmaInit

> **sigmaInit**: `number`

Defined in: [scoring.ts:32](https://github.com/victusfate/ricochet/blob/59ce69b73244814ea60961ffa3aff25bf8fadcaf/src/scoring.ts#L32)

Standard deviation for random normal factor initialisation. Default: 0.1.
