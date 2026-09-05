import { Address } from '@ton/core'

/**
 * Mainnet addresses the scripts work with.
 *
 * Kept in one place so they cannot drift apart between scripts. These mirror the compile-time
 * constants in `contracts/imports/constants.fc`; `scripts/deployBurner.ts` checks that mirror
 * against the chain before it will deploy anything.
 */

/**
 * The deployed burner.
 *
 * Every script offers this as the default and lets it be overridden, rather than deriving it.
 * A derived address comes from the contract's *initial* state, which includes the original
 * owner -- so a derivation silently stops reproducing the right address the moment ownership
 * moves, which is exactly when an operator can least afford a wrong default.
 */
export const BURNER = Address.parse('EQAGPJMxJ73OLpHUgQhI5YeQe2ZuAuUQ-4f_zfN4rV2Fl6Jp')

/** Hipo. The parent is also the hGRAM jetton master. */
export const HIPO_TREASURY = Address.parse('EQCLyZHP4Xe8fpchQz76O-_RmUhaVc_9BAoGyJrwJrcbz2eZ')
export const HIPO_PARENT = Address.parse('EQDPdq8xjAhytYqfGSX8KcFWIReCufsB9Wdg0pLlYSO_h76w')
export const HGRAM = HIPO_PARENT

/** HPO jetton master. */
export const HPO = Address.parse('EQDQEUr0LPi8m6D6F0Wrvuok7tZbAcr0yn2Y7hK291MMzMjM')

/** DeDust: the pool the burn trades in, and the vault it enters through. */
export const DEDUST_POOL = Address.parse('EQCXJu7zUBQILdzt1nIzz_NhDfVZ-FyEdnccFDYDPRaAqfqU')
export const DEDUST_HGRAM_VAULT = Address.parse('EQCRjILmJD0ZD7y6POFyicCx20PoypkEwHJ64AMJ7vwkXGjm')
