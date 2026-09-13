const descriptions: Record<string, string> = {
  click: 'События click связаны с нажатием на элемент страницы.',
  copy: 'События copy связаны с копированием текста или другого содержимого.',
  cut: 'События cut связаны с вырезанием содержимого.',
  paste: 'События paste связаны со вставкой содержимого.',
  input: 'События input связаны с изменением значения поля или другого редактируемого элемента.',
  unknown: 'Назначение этого типа события пока не описано в локальном справочнике.',
};

export function describeEvent(eventType: string): string {
  return descriptions[eventType] ?? descriptions.unknown;
}
