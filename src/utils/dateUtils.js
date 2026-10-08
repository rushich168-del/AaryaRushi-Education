/**
 * Centralized Date Formatting Utility for Career Suite
 * 
 * CORE PRINCIPLE:
 * User-entered data is the source of truth.
 * NEVER invent or infer missing start years or end years.
 * 
 * Formatting Rules:
 * 1. start = "2018", end = "2022"                  -> "2018 – 2022"
 * 2. start = "2020", end = "2020"                  -> "2020"
 * 3. start = "2018", end = "", isOngoing = true    -> "2018 – Present"
 * 4. start = "2018", end = "", isOngoing = false   -> "2018"
 * 5. start = "",     end = "2022"                  -> "2022"
 * 6. start = "",     end = ""                      -> ""
 */

export function formatDateRange(
  startDate,
  endDate,
  { isOngoing = false, ongoingText = 'Present' } = {}
) {
  const start = (startDate || '').toString().trim()
  const end = (endDate || '').toString().trim()

  if (start && end) {
    if (start === end) return start
    return `${start} – ${end}`
  }

  if (start && !end) {
    if (isOngoing) {
      return `${start} – ${ongoingText}`
    }
    return start
  }

  if (!start && end) {
    return end
  }

  return ''
}

/**
 * Formats a valid date string (e.g., ISO string) into a readable format (e.g., "Oct 12, 2023").
 */
export function formatDate(dateString) {
  if (!dateString) return 'Unknown Date';
  try {
    const d = new Date(dateString);
    if (isNaN(d.getTime())) return dateString;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch (err) {
    return dateString;
  }
}
