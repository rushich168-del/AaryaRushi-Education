import RowMenu from '../RowMenu.jsx'

// Admin-only paper management, kept away from the Publish button.
// The server decides what is allowed through can_bring_back / can_delete.
export default function PaperMenu({ paper, disabled, onBringBack, onDelete }) {
  const items = [
    paper.can_bring_back && { label: 'Bring back to edit', onSelect: () => onBringBack(paper) },
    paper.can_delete && { label: 'Delete from library', danger: true, onSelect: () => onDelete(paper) },
  ].filter(Boolean)

  return <RowMenu label={`More actions for ${paper.title}, version ${paper.version}`} items={items} disabled={disabled} />
}
