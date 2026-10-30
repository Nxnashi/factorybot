// Статичные справочники. Менять только здесь (в коде) — через админку они НЕ редактируются.

// Замес глины — список как в документе 1С "Глина" (порядок строк сохранён)
const CLAY_MATERIALS = [
  { article: '1',  name: 'Полевой шпат (обогащённый)' },
  { article: 'R1', name: 'Полевой шпат необогащённый (сырьё)' },
  { article: '2',  name: 'Кварц' },
  { article: '3',  name: 'Доломит' },
  { article: '4',  name: 'Каолин серый обогащённый' },
  { article: 'R4', name: 'Каолин серый необогащённый' },
  { article: '5',  name: 'Каолин АКФ-30 обогащённый' },
  { article: 'R5', name: 'Каолин 30 необогащённый' },
  { article: '6',  name: 'Каолин АКС-78 обогащённый' },
  { article: 'R6', name: 'Каолин 78 необогащённый' },
  { article: 'R7', name: 'Глинозём (по бланку)' },
  { article: '8',  name: 'Сода' },
  { article: '9',  name: 'Жидкое стекло' },
  { article: '10', name: 'Глинозём (по бланку)' },
  { article: '11', name: 'Вода' },
];

// Замес глазури — пока по прежнему списку (без артикулов). Скинешь фото — заменим здесь.
const GLAZE_MATERIALS = [
  { article: null, name: 'Полевой шпат' },
  { article: null, name: 'Кварц' },
  { article: null, name: 'Кальцит' },
  { article: null, name: 'Тальк' },
  { article: null, name: 'Оксид алюминия' },
  { article: null, name: 'Барий карбонат' },
  { article: null, name: 'Силикат циркония' },
  { article: null, name: 'Оксид цинка' },
  { article: null, name: 'Каолин' },
  { article: null, name: 'КМЦ клей' },
];

// Барабаны: у глины 3, у глазури всегда 1
const DRUMS = { clay_mixing: [1, 2, 3], glaze_mixing: [1] };

// Префиксы кодов операций
const CODE_PREFIX = {
  clay_mixing: 'GL',
  glaze_mixing: 'GZ',
  molding: 'FM',
  fettling: 'OP',
  glazing: 'GR',
  kiln: 'PC',
  sorting: 'SR',
  finished: 'GP',
};

module.exports = { CLAY_MATERIALS, GLAZE_MATERIALS, DRUMS, CODE_PREFIX };
