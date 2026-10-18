export const EVENT_CATALOG = Object.freeze({
  click: "События click связаны с нажатием на элемент страницы.",
  mousedown: "События mousedown связаны с нажатием кнопки мыши над элементом.",
  mouseup: "События mouseup связаны с отпусканием кнопки мыши над элементом.",
  mousemove: "События mousemove связаны с перемещением курсора над элементом.",
  mouseenter: "События mouseenter связаны с входом курсора в область элемента.",
  mouseleave:
    "События mouseleave связаны с выходом курсора за границы элемента и его потомков.",
  mouseover:
    "События mouseover связаны с входом курсора на элемент или его потомка.",
  mouseout:
    "События mouseout связаны с уходом курсора с элемента, в том числе на его потомка.",
  dblclick:
    "События dblclick связаны с двойным нажатием кнопки мыши над элементом.",
  contextmenu: "События contextmenu связаны с запросом контекстного меню.",
  pointerdown:
    "События pointerdown связаны с началом активного контакта указателя: мыши, пера или касания.",
  pointerup:
    "События pointerup связаны с завершением активного контакта указателя.",
  pointermove: "События pointermove связаны с перемещением указателя.",
  pointercancel:
    "События pointercancel связаны с отменой браузером взаимодействия указателя.",
  pointerenter:
    "События pointerenter связаны с попаданием указателя в область элемента.",
  pointerleave:
    "События pointerleave связаны с выходом указателя за границы элемента и его потомков.",
  pointerover:
    "События pointerover связаны с попаданием указателя на элемент или его потомка.",
  pointerout:
    "События pointerout связаны с уходом указателя с элемента, в том числе на его потомка.",
  keydown: "События keydown связаны с нажатием клавиши.",
  keyup: "События keyup связаны с отпусканием клавиши.",
  focus: "События focus связаны с получением фокуса элементом.",
  blur: "События blur связаны с потерей фокуса элементом.",
  focusin:
    "События focusin связаны с получением фокуса элементом или его потомком.",
  focusout:
    "События focusout связаны с потерей фокуса элементом или его потомком.",
  beforeinput:
    "События beforeinput возникают перед изменением содержимого редактируемого элемента.",
  input:
    "События input связаны с изменением значения поля или другого редактируемого элемента.",
  change:
    "События change связаны с фиксацией изменения значения элемента формы.",
  submit: "События submit связаны с попыткой отправки формы.",
  reset: "События reset связаны со сбросом значений формы.",
  invalid:
    "События invalid связаны с ошибкой проверки допустимости значения элемента формы.",
  copy: "События copy связаны с копированием текста или другого содержимого.",
  cut: "События cut связаны с вырезанием содержимого.",
  paste: "События paste связаны со вставкой содержимого.",
  wheel:
    "События wheel связаны с вращением колеса мыши или аналогичным жестом устройства.",
  scroll: "События scroll связаны с изменением позиции прокрутки.",
  load: "События load связаны с завершением загрузки ресурса.",
  error:
    "События error связаны с ошибкой загрузки ресурса или выполнения скрипта.",
} as const);

export type SupportedEventType = keyof typeof EVENT_CATALOG;

export const SUPPORTED_EVENT_TYPES: readonly SupportedEventType[] =
  Object.freeze(Object.keys(EVENT_CATALOG) as SupportedEventType[]);

const fallbackDescription =
  "Назначение этого типа события пока не описано в локальном справочнике.";

export function isSupportedEventType(
  eventType: string,
): eventType is SupportedEventType {
  return Object.prototype.hasOwnProperty.call(EVENT_CATALOG, eventType);
}

export function describeEvent(eventType: string): string {
  return isSupportedEventType(eventType)
    ? EVENT_CATALOG[eventType]
    : fallbackDescription;
}
