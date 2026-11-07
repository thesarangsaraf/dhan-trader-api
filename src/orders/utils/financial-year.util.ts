export interface FinancialYearInfo {
  label: string;
  value: string; // e.g. "2026-2027"
  fromDate: string; // "2026-04-01"
  toDate: string; // "2027-03-31" or capped at today for current year
  isCurrent: boolean;
}

/**
 * Formats a Date object to YYYY-MM-DD
 */
export function formatDate(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Returns available Indian Financial Years (current FY + preceding historical FYs)
 */
export function getAvailableFinancialYears(count = 5, refDate = new Date()): FinancialYearInfo[] {
  const year = refDate.getFullYear();
  const month = refDate.getMonth() + 1; // 1-12
  const currentStartYear = month >= 4 ? year : year - 1;
  const todayStr = formatDate(refDate);

  const list: FinancialYearInfo[] = [];

  for (let i = 0; i < count; i++) {
    const sYear = currentStartYear - i;
    const eYear = sYear + 1;
    const isCurrent = i === 0;
    const shortEndYear = String(eYear).slice(-2);
    const label = isCurrent
      ? `FY ${sYear}-${shortEndYear} (Current)`
      : `FY ${sYear}-${shortEndYear}`;

    list.push({
      label,
      value: `${sYear}-${eYear}`,
      fromDate: `${sYear}-04-01`,
      toDate: isCurrent ? todayStr : `${eYear}-03-31`,
      isCurrent,
    });
  }

  return list;
}

/**
 * Resolves start date, end date, and financial year string from input or defaults to current FY.
 */
export function resolveFinancialYearDates(
  financialYear?: string,
  fromDate?: string,
  toDate?: string,
  refDate = new Date(),
): {
  financialYear: string;
  fromDate: string;
  toDate: string;
  isCurrent: boolean;
} {
  const available = getAvailableFinancialYears(5, refDate);
  const currentFy = available[0];

  // 1. If explicit custom dates are provided
  if (fromDate && toDate) {
    return {
      financialYear: financialYear || 'CUSTOM',
      fromDate,
      toDate,
      isCurrent: fromDate === currentFy.fromDate && toDate === currentFy.toDate,
    };
  }

  // 2. If a specific financial year is requested (e.g. "2025-2026" or "2025-26")
  if (financialYear) {
    const cleanFy = financialYear.trim();
    const matched = available.find(
      (fy) => fy.value === cleanFy || fy.label.toLowerCase().includes(cleanFy.toLowerCase()),
    );
    if (matched) {
      return {
        financialYear: matched.value,
        fromDate: matched.fromDate,
        toDate: matched.toDate,
        isCurrent: matched.isCurrent,
      };
    }

    // Attempt parsing "YYYY-YYYY" format
    const parts = cleanFy.split('-');
    if (parts.length === 2) {
      const sYear = parseInt(parts[0], 10);
      let eYear = parseInt(parts[1], 10);
      if (parts[1].length === 2) {
        eYear = Math.floor(sYear / 100) * 100 + eYear;
      }
      if (!isNaN(sYear) && !isNaN(eYear)) {
        const isCurrent = sYear === parseInt(currentFy.value.split('-')[0], 10);
        return {
          financialYear: `${sYear}-${eYear}`,
          fromDate: `${sYear}-04-01`,
          toDate: isCurrent ? formatDate(refDate) : `${eYear}-03-31`,
          isCurrent,
        };
      }
    }
  }

  // 3. Default to current financial year
  return {
    financialYear: currentFy.value,
    fromDate: currentFy.fromDate,
    toDate: currentFy.toDate,
    isCurrent: true,
  };
}
