/**
 * Validate the analyzer's ASCII identifier/reserved-name policy for declarations and variable rename.
 */
export function validVariableName(name: string): boolean {
  return (
    /^[A-Za-z]\w*$/.test(name) && !/^(?:and|or|true|false|scene|scenename)$/i.test(name) && !/^choice_/i.test(name)
  );
}
