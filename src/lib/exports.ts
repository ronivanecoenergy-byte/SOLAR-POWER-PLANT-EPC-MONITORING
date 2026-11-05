// Excel and PDF exports (10.5). Libraries load on demand.
export type Sheet = { name: string; rows: Record<string, unknown>[] };

export async function exportXlsx(filename: string, sheets: Sheet[]) {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const ws = XLSX.utils.json_to_sheet(s.rows.length ? s.rows : [{ Note: 'No records' }]);
    const cols = Object.keys(s.rows[0] || { Note: '' });
    ws['!cols'] = cols.map((c) => ({ wch: Math.min(48, Math.max(c.length + 2, ...s.rows.slice(0, 200).map((r) => String(r[c] ?? '').length + 1))) }));
    XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
  }
  XLSX.writeFile(wb, filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`);
}

export interface PdfSection { heading: string; note?: string; columns: string[]; rows: (string | number)[][] }
export async function exportPdf(filename: string, title: string, subtitle: string, sections: PdfSection[]) {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const header = () => {
    doc.setFillColor(19, 33, 50); doc.rect(0, 0, W, 54, 'F');
    doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.text(title, 32, 26);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.text(subtitle, 32, 42);
    doc.setTextColor(19, 33, 50);
  };
  header();
  let y = 76;
  for (const s of sections) {
    if (y > doc.internal.pageSize.getHeight() - 90) { doc.addPage(); header(); y = 76; }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11.5); doc.text(s.heading, 32, y); y += 6;
    if (s.note) { doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(90, 100, 112); doc.text(s.note, 32, y + 10); doc.setTextColor(19, 33, 50); y += 14; }
    autoTable(doc, {
      startY: y + 6, head: [s.columns], body: s.rows.length ? s.rows.map((r) => r.map((c) => String(c))) : [[`No records`, ...s.columns.slice(1).map(() => '')]],
      styles: { fontSize: 8.5, cellPadding: 4, lineColor: [211, 218, 221], lineWidth: 0.5 }, headStyles: { fillColor: [235, 239, 238], textColor: [19, 33, 50], fontStyle: 'bold' },
      margin: { left: 32, right: 32, top: 70 }, didDrawPage: () => header(),
    });
    y = (doc as any).lastAutoTable.finalY + 26;
  }
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i); doc.setFontSize(8); doc.setTextColor(110, 120, 130);
    doc.text(`Generated ${new Date().toLocaleString()} from the project database · page ${i} of ${pages}`, 32, doc.internal.pageSize.getHeight() - 18);
  }
  doc.save(filename.endsWith('.pdf') ? filename : `${filename}.pdf`);
}
