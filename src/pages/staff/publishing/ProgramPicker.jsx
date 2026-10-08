// Narrows the list to one program. "All programs" is the default, so nothing has to be chosen first.
// Counts are papers still waiting to be published.
export default function ProgramPicker({ programs, selectedId, disabled, onSelect }) {
  if (programs.length < 2) return null
  const total = programs.reduce((sum, program) => sum + program.ready, 0)
  const options = [{ id: '', name: 'All programs', ready: total }, ...programs]
  return (
    <div className="pub-chips pub-programs" role="group" aria-label="Filter by program">
      {options.map(program => (
        <button
          key={program.id || 'all'}
          type="button"
          className="pub-chip"
          aria-pressed={program.id === selectedId}
          aria-label={`${program.name}, ${program.ready} ready to publish`}
          disabled={disabled}
          onClick={() => onSelect(program.id)}
        >
          <span className="pub-chip-name">{program.name}</span>
          <span className={'pub-chip-count' + (program.ready ? '' : ' is-zero')}>{program.ready}</span>
        </button>
      ))}
    </div>
  )
}
