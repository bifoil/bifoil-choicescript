package core

// Routine summaries inspect one row at a time. Indexing substitutions once
// avoids rescanning every interpolation in the scene for each command.
func (d *Document) rowSubstitutions(line uint32) []uint32 {
	if d.substitutionRows == nil {
		d.substitutionRows = make(map[uint32][]uint32)
		for location, expression := range d.Substitutions {
			row := uint32(location>>32) + 1
			d.substitutionRows[row] = append(d.substitutionRows[row], expression)
		}
	}
	return d.substitutionRows[line]
}
