import type { TypeDefinitionFile } from '@shared/types'

/** Only count the entry point that Node module resolution can actually find. */
export function hasReactJsxRuntimeTypes(files: readonly TypeDefinitionFile[]): boolean {
  return files.some((file) => /^file:\/\/\/workspace\/node_modules\/(?:@types\/)?react\/jsx-runtime\.d\.ts$/.test(file.uri))
}

/**
 * Monaco only checks source (noEmit); esbuild owns the automatic JSX transform.
 * Without workspace React declarations, preserve avoids requiring a runtime
 * module that this virtual type-only filesystem cannot resolve. It still checks
 * syntax, local component props and all other available types.
 */
export function getEditorJsxMode<T>(
  files: readonly TypeDefinitionFile[],
  modes: { Preserve: T; ReactJSX: T }
): T {
  return hasReactJsxRuntimeTypes(files) ? modes.ReactJSX : modes.Preserve
}
