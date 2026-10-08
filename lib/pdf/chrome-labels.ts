// lib/pdf/chrome-labels.ts
// Fixed wording printed by the SOW PDF itself (headers, party labels, signature block, footer) in the
// document's drafting language. Falls back to English for any missing language/key.

export interface PdfChrome {
  sow: string; version: string; signed: string
  contractValue: string; monthlyRetainer: string; months: string; total: string; perMonth: string
  agencyProvider: string; client: string; taxId: string; vat: string
  agencyLabel: string; clientLabel: string; notYetSigned: string
  scopeGovBy: string; generated: string; page: (n: number, t: number) => string
  exclTax: (rate: number) => string; inclTax: (rate: number) => string
}

const EN: PdfChrome = {
  sow: 'Statement of Work', version: 'Version', signed: 'Signed',
  contractValue: 'Contract value', monthlyRetainer: 'Monthly retainer fee', months: 'months', total: 'total', perMonth: 'mo',
  agencyProvider: 'Provider', client: 'Client', taxId: 'Tax ID', vat: 'VAT',
  agencyLabel: 'Provider', clientLabel: 'Client', notYetSigned: 'Not yet signed',
  scopeGovBy: 'Scope governance by', generated: 'Generated', page: (n, t) => `Page ${n} of ${t}`,
  exclTax: r => `excl. ${r}% tax`, inclTax: r => `incl. ${r}% tax`,
}

const L: Record<string, Partial<PdfChrome>> = {
  sw: { sow: 'Hati ya Wigo wa Kazi', version: 'Toleo', signed: 'Imetiwa saini', contractValue: 'Thamani ya Mkataba',
    monthlyRetainer: 'Ada ya kila mwezi', months: 'miezi', total: 'jumla', perMonth: 'mwezi',
    agencyProvider: 'Wakala (Mtoa Huduma)', client: 'Mteja', taxId: 'Kitambulisho cha Kodi', vat: 'VAT',
    agencyLabel: 'Wakala', clientLabel: 'Mteja', notYetSigned: 'Bado haijatiwa saini',
    scopeGovBy: 'Usimamizi wa wigo na', generated: 'Imetengenezwa', page: (n, t) => `Ukurasa ${n} wa ${t}`,
    exclTax: r => `bila kodi ya ${r}%`, inclTax: r => `pamoja na kodi ya ${r}%` },
  es: { sow: 'Declaración de Trabajo', version: 'Versión', signed: 'Firmado', contractValue: 'Valor del contrato',
    monthlyRetainer: 'Cuota mensual', months: 'meses', total: 'total', perMonth: 'mes',
    agencyProvider: 'Agencia (Proveedor de servicios)', client: 'Cliente', taxId: 'ID fiscal', vat: 'IVA',
    agencyLabel: 'Agencia', clientLabel: 'Cliente', notYetSigned: 'Aún sin firmar',
    scopeGovBy: 'Gobernanza del alcance por', generated: 'Generado', page: (n, t) => `Página ${n} de ${t}`,
    exclTax: r => `sin ${r}% de impuesto`, inclTax: r => `con ${r}% de impuesto incluido` },
  fr: { sow: 'Énoncé des travaux', version: 'Version', signed: 'Signé', contractValue: 'Valeur du contrat',
    monthlyRetainer: 'Forfait mensuel', months: 'mois', total: 'total', perMonth: 'mois',
    agencyProvider: 'Agence (Prestataire)', client: 'Client', taxId: 'N° fiscal', vat: 'TVA',
    agencyLabel: 'Agence', clientLabel: 'Client', notYetSigned: 'Pas encore signé',
    scopeGovBy: 'Gouvernance du périmètre par', generated: 'Généré', page: (n, t) => `Page ${n} sur ${t}`,
    exclTax: r => `hors taxe de ${r} %`, inclTax: r => `taxe de ${r} % incluse` },
  pt: { sow: 'Declaração de Trabalho', version: 'Versão', signed: 'Assinado', contractValue: 'Valor do contrato',
    monthlyRetainer: 'Mensalidade', months: 'meses', total: 'total', perMonth: 'mês',
    agencyProvider: 'Agência (Prestador de serviços)', client: 'Cliente', taxId: 'ID fiscal', vat: 'IVA',
    agencyLabel: 'Agência', clientLabel: 'Cliente', notYetSigned: 'Ainda não assinado',
    scopeGovBy: 'Governança de escopo por', generated: 'Gerado', page: (n, t) => `Página ${n} de ${t}`,
    exclTax: r => `sem ${r}% de imposto`, inclTax: r => `com ${r}% de imposto incluído` },
  de: { sow: 'Leistungsbeschreibung', version: 'Version', signed: 'Unterzeichnet', contractValue: 'Vertragswert',
    monthlyRetainer: 'Monatliche Pauschale', months: 'Monate', total: 'gesamt', perMonth: 'Monat',
    agencyProvider: 'Agentur (Dienstleister)', client: 'Kunde', taxId: 'Steuer-ID', vat: 'USt-IdNr.',
    agencyLabel: 'Agentur', clientLabel: 'Kunde', notYetSigned: 'Noch nicht unterzeichnet',
    scopeGovBy: 'Scope-Governance von', generated: 'Erstellt', page: (n, t) => `Seite ${n} von ${t}`,
    exclTax: r => `zzgl. ${r} % Steuer`, inclTax: r => `inkl. ${r} % Steuer` },
}

export function pdfChrome(language?: string): PdfChrome {
  if (!language || language === 'en') return EN
  return { ...EN, ...(L[language] || {}) }
}
