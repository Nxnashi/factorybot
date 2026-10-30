// Человекочитаемое описание операции — используется в ленте, журнале проводок и Excel
function n(v) { return v == null ? 0 : Number(v); }

function describeEntry(stage, r) {
  switch (stage) {
    case 'molding':
      return `Линия ${r.line_no}: залито ${n(r.qty_total)}, годных ${n(r.quantity)}, возврат в глину ${n(r.qty_defect)}`;
    case 'fettling':
    case 'glazing':
      return `всего ${n(r.qty_total)}, брак ${n(r.qty_defect)}, годных ${n(r.quantity)}`;
    case 'kiln':
      return `Вагон ${r.wagon_no}: ${n(r.quantity)} шт`;
    case 'sorting':
      return `Сорт-1 ${n(r.qty_s1)}, Сорт-2 ${n(r.qty_s2)}, ремонт ${n(r.qty_repair)}, брак/бой ${n(r.qty_defect)}`;
    case 'finished':
      return `Сорт ${r.grade || '—'}: ${n(r.quantity)} шт`;
    default:
      return `${n(r.quantity)}`;
  }
}

module.exports = { describeEntry };
