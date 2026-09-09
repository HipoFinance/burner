import { CompilerConfig } from '@ton/blueprint'

export const compile: CompilerConfig = {
    lang: 'func',
    targets: ['contracts/mock/migrators/drop_owner.fc'],
}
