import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema";

export * from "./auth-schema";

// --- FRAÇÕES ---
export const fracoes = sqliteTable("fracoes", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  numero: text("numero").notNull(),           // "1A", "2B", etc.
  andar: integer("andar"),
  proprietarioNome: text("proprietario_nome"),
  proprietarioEmail: text("proprietario_email"),
  proprietarioNif: text("proprietario_nif"),
  proprietarioMorada: text("proprietario_morada"),   // ex: "Rua Poeta António Boto, n.º 39, Hab. 2.º B"
  proprietarioTelefone: text("proprietario_telefone"),
  telegramId: text("telegram_id"),
  tipo: text("tipo").notNull().default("apartamento"), // "apartamento" | "loja" | "garagem"
  ibansConhecidos: text("ibans_conhecidos"),            // JSON array de IBANs associados (estáticos + aprendidos)
  /** Nomes alternativos do proprietário / negócio (JSON array). Ex: ["MARMA","MARCO ANDRE MENDES MAIA"] */
  proprietarioAliases: text("proprietario_aliases"),
  quotaMensal: real("quota_mensal").notNull().default(0),
  permilagem: real("permilagem"),             // % do edifício
  // Dívidas extra por tipo — actualizadas pela cascata de amortização
  obrasDivida: real("obras_divida").default(0),
  incendioDivida: real("incendio_divida").default(0),
  indaquaDivida: real("indaqua_divida").default(0),
  motorDivida: real("motor_divida").default(0),
  iban: text("iban"),
  ibanSecundario: text("iban_secundario"),
  ativo: integer("ativo", { mode: "boolean" }).default(true),
  notas: text("notas"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// --- FORNECEDORES ---
export const fornecedores = sqliteTable("fornecedores", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  nome: text("nome").notNull(),
  categoria: text("categoria"),               // "limpeza", "jardim", "elevadores", etc.
  nif: text("nif"),
  email: text("email"),
  telefone: text("telefone"),
  website: text("website"),
  avaliacao: real("avaliacao"),               // 1.0 a 5.0
  iban: text("iban"),
  ibanSecundario: text("iban_secundario"),
  ativo: integer("ativo", { mode: "boolean" }).default(true),
  notas: text("notas"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// --- DESPESAS ---
export const despesas = sqliteTable("despesas", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  descricao: text("descricao").notNull(),
  categoria: text("categoria").notNull(),     // "água", "eletricidade", "limpeza", "manutenção", "seguros", "outros"
  subcategoria: text("subcategoria"),
  valor: real("valor").notNull(),
  data: integer("data", { mode: "timestamp" }).notNull(),
  fornecedorId: text("fornecedor_id").references(() => fornecedores.id),
  faturaUrl: text("fatura_url"),
  recorrente: integer("recorrente", { mode: "boolean" }).default(false),
  notas: text("notas"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// --- QUOTAS ---
export const quotas = sqliteTable("quotas", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  fracaoId: text("fracao_id").notNull().references(() => fracoes.id),
  quotaTipoId: text("quota_tipo_id"),         // optional link to quota_tipos
  tipo: text("tipo").notNull().default("condominio"), // "condominio" | "obras" | "extra" | "fundo_reserva"
  mes: integer("mes").notNull(),
  ano: integer("ano").notNull(),
  valor: real("valor").notNull(),
  fundoReserva: real("fundo_reserva"),        // 10% auto-calculated, stored separately
  pago: integer("pago", { mode: "boolean" }).default(false),
  dataPagamento: integer("data_pagamento", { mode: "timestamp" }),
  metodoPagamento: text("metodo_pagamento"),  // "transferência", "mbway", "numerário", "cheque"
  observacoes: text("observacoes"),
  dataVencimento: integer("data_vencimento", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// --- RECIBOS ---
export const recibos = sqliteTable("recibos", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  fracaoId: text("fracao_id").notNull().references(() => fracoes.id),
  quotaId: text("quota_id").references(() => quotas.id),
  numeroRecibo: text("numero_recibo").unique(), // "2026.95"
  mes: integer("mes"),                          // 1-12
  ano: integer("ano"),                          // 2026
  valor: real("valor").notNull(),
  pdfUrl: text("pdf_url"),
  hashSha256: text("hash_sha256"),             // blockchain-ready
  txHash: text("tx_hash"),                     // on-chain futuro
  enviadoEmail: integer("enviado_email", { mode: "boolean" }).default(false),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// --- IMPORT LOGS ---
export const importLogs = sqliteTable("import_logs", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  filename: text("filename").notNull(),
  fileHash: text("file_hash"),               // SHA-256 of file to detect re-imports
  status: text("status").notNull().default("ok"), // "ok" | "error" | "partial"
  totalRows: integer("total_rows").default(0),
  quotasCreated: integer("quotas_created").default(0),
  quotasUpdated: integer("quotas_updated").default(0),
  despesasCreated: integer("despesas_created").default(0),
  despesasSkipped: integer("despesas_skipped").default(0),
  errorCount: integer("error_count").default(0),
  errors: text("errors"),                    // JSON array of error strings
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// --- BANK CONNECTIONS (Enable Banking) ---
export const bankConnections = sqliteTable("bank_connections", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  sessionId: text("session_id").notNull(),
  bankName: text("bank_name").notNull().default("Santander Empresas PT"),
  accounts: text("accounts"),               // JSON array of account objects
  status: text("status").notNull().default("active"), // "active" | "expired" | "revoked"
  connectedAt: integer("connected_at", { mode: "timestamp" }),
  expiresAt: integer("expires_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// --- BANK SYNC LOGS ---
export const bankSyncLogs = sqliteTable("bank_sync_logs", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  connectionId: text("connection_id"),
  syncedFrom: integer("synced_from", { mode: "timestamp" }),
  syncedTo: integer("synced_to", { mode: "timestamp" }),
  transactionsFound: integer("transactions_found").default(0),
  despesasCreated: integer("despesas_created").default(0),
  quotasCreated: integer("quotas_created").default(0),
  quotasUpdated: integer("quotas_updated").default(0),
  skipped: integer("skipped").default(0),
  errors: text("errors"),                   // JSON array
  status: text("status").notNull().default("ok"), // "ok" | "partial" | "error"
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// --- CONFIGURAÇÕES (chave-valor) ---
export const configuracoes = sqliteTable("configuracoes", {
  chave: text("chave").primaryKey(),            // "saldo_conta_corrente", "saldo_obras", "saldo_fundo_reserva"
  valor: text("valor").notNull(),               // JSON string or plain value
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// --- TRANSAÇÕES BANCÁRIAS (Enable Banking staging) ---
// Recebidas via sync antes de serem importadas como quotas/despesas.
// imported=0 → ainda não processadas (potencialmente "cativos" na conta à ordem).
// imported=1 → já gerou quota ou despesa; import_type indica o destino.
export const bankTransactions = sqliteTable("bank_transactions", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  connectionId: text("connection_id").references(() => bankConnections.id),
  transactionId: text("transaction_id").unique(), // ID externo Enable Banking (dedup)
  amount: real("amount").notNull(),               // positivo = crédito, negativo = débito
  currency: text("currency").default("EUR"),
  date: integer("date", { mode: "timestamp" }).notNull(),
  description: text("description"),              // remittance_information concatenado
  creditorName: text("creditor_name"),           // nome do credor (saídas)
  debtorName: text("debtor_name"),               // nome do devedor/pagador (entradas)
  debtorIban: text("debtor_iban"),               // IBAN do remetente — âncora de persistência antierro
  type: text("type"),                            // "CRDT" | "DBIT"
  status: text("status").default("pending"),     // "pending" | "processed" | "ignored"
  imported: integer("imported").default(0),      // 0=não processado, 1=importado
  importType: text("import_type"),               // "quota" | "despesa" | "cativo"
  importRefId: text("import_ref_id"),            // ID da quota/despesa criada
  requiresManualReview: integer("requires_manual_review").default(0), // 1=motor devolveu null, revisão manual
  rawData: text("raw_data"),                     // JSON raw do Enable Banking
  rubricaExtra: text("rubrica_extra"),           // "CONDOMINIO" | "OBRAS" | "MOTOR" | "INCENDIO" | "ELEVADORES"
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// --- TIPOS DE QUOTA ---
export const quotaTipos = sqliteTable("quota_tipos", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  nome: text("nome").notNull(),               // "Quota Condomínio", "Fundo Obras", etc.
  tipo: text("tipo").notNull(),               // "condominio" | "obras" | "extra" | "fundo_reserva"
  descricao: text("descricao"),
  keywords: text("keywords"),               // CSV keywords para matching bancário: "MOTOR GARAGEM,PORTAO"
  valorBase: real("valor_base"),             // base value (before permilagem calc)
  ativo: integer("ativo", { mode: "boolean" }).default(true),
  dataInicio: integer("data_inicio", { mode: "timestamp" }),
  dataFim: integer("data_fim", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// --- PERFIS DE PAGADOR (aprendizagem cross-condomínio) ---
// Mapeia (IBAN e/ou nome + valor) → fração + rubrica.
// Ex.: Rui Carvalho IBAN+X €40,33 → AI; mesmo IBAN €46,08 → AH.
// Alimentado por classificação manual e matches automáticos confirmados.
export const pagadorPerfis = sqliteTable("pagador_perfis", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  /** IBAN normalizado (sem espaços); opcional se só houver nome */
  iban: text("iban"),
  /** Nome do remetente normalizado (uppercase, sem acentos) */
  nomeNormalizado: text("nome_normalizado"),
  /** Montante exacto tipicamente transferido (€) */
  valor: real("valor").notNull(),
  /** Fração destino (UUID em fracoes.id) */
  fracaoId: text("fracao_id").notNull().references(() => fracoes.id),
  /** Número curto da fração (AI, G, …) — denormalizado para lookups rápidos */
  fracaoNumero: text("fracao_numero").notNull(),
  /** Rubrica: condominio | obras | extra | fundo_reserva */
  rubrica: text("rubrica").notNull().default("condominio"),
  /** Quantas vezes este perfil foi confirmado (manual ou auto) */
  confirmacoes: integer("confirmacoes").notNull().default(1),
  /** Origem da última confirmação */
  fonte: text("fonte").notNull().default("manual"), // "manual" | "auto"
  ativo: integer("ativo", { mode: "boolean" }).default(true),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// --- RATEIOS / COMPARTICIPAÇÕES ---
// Ex.: campainhas — N condóminos transferem valor fixo ao condomínio;
// o condomínio paga depois o fornecedor. Não é quota mensal.
export const rateioCampanhas = sqliteTable("rateio_campanhas", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  nome: text("nome").notNull(),
  descricao: text("descricao"),
  valorUnitario: real("valor_unitario").notNull(),
  quantidadeEsperada: integer("quantidade_esperada").notNull().default(1),
  quantidadeRecebida: integer("quantidade_recebida").notNull().default(0),
  totalRecebido: real("total_recebido").notNull().default(0),
  /** Keywords CSV para auto-match: "CAMPAINHA,CAMPAINHAS" */
  keywords: text("keywords"),
  /** JSON array de números de fração esperados: ["AB","AE","AH",…] */
  fracoesEsperadas: text("fracoes_esperadas"),
  status: text("status").notNull().default("aberta"), // aberta | completa | paga
  fornecedorNome: text("fornecedor_nome"),
  /** Débito ao fornecedor (quando status=paga) */
  pagoValor: real("pago_valor"),
  pagoBankTransactionId: text("pago_bank_transaction_id"),
  pagoEm: integer("pago_em", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const rateioPagamentos = sqliteTable("rateio_pagamentos", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  campanhaId: text("campanha_id").notNull().references(() => rateioCampanhas.id),
  bankTransactionId: text("bank_transaction_id").references(() => bankTransactions.id),
  fracaoId: text("fracao_id").references(() => fracoes.id),
  valor: real("valor").notNull(),
  debtorName: text("debtor_name"),
  data: integer("data", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// --- NOTAS DE REUNIÃO (internas, admin only) ---
/**
 * Máquina de estados (persistida) — alinhada ao ciclo de gravação contínua:
 *
 *   em_curso ──(Terminar reunião)──► processando_audio ──► rascunho
 *                                         │
 *                                         └──► erro_audio ──(reprocessar)──► processando_audio
 *   rascunho ──(aprovar)──► aprovada
 *
 * `terminada` NÃO é usada no fluxo actual: a intenção humana de terminar
 * passa directamente a `processando_audio` (STT/LLM). Reservado / legado.
 * Falha técnica NUNCA sai de `em_curso`.
 *
 * tenantId: carimbo do tenant da BD (ADR-016 = 1 BD/tenant; defesa em profundidade).
 */
export const reunioes = sqliteTable(
  "reunioes",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    /** Ownership — preenchido no servidor a partir da sessão/config; nunca do cliente. */
    tenantId: text("tenant_id").notNull(),
    titulo: text("titulo").notNull(),
    data: integer("data", { mode: "timestamp" }).notNull(),
    /** "interna" (administradores) | "fornecedor" */
    tipo: text("tipo").notNull().default("interna"),
    /** Nome do fornecedor (quando tipo === "fornecedor") */
    fornecedorNome: text("fornecedor_nome"),
    participantes: text("participantes"),
    transcricao: text("transcricao"),
    /** JSON estruturado da reunião conforme layout do tipo */
    resumoJson: text("resumo_json"),
    resumo: text("resumo"),
    /**
     * "em_curso" | "rascunho" | "processando_audio" | "erro_audio" | "aprovada"
     * (`terminada` legado — não usado no fluxo actual)
     */
    status: text("status").notNull().default("rascunho"),
    pdfUrl: text("pdf_url"),
    approvedAt: integer("approved_at", { mode: "timestamp" }),
    /** Legado: primeiro/único ficheiro. Preferir recording_segments. */
    audioPath: text("audio_path"),
    /**
     * Contador de geração de processamento — incrementado em cada end-meeting
     * que inicia STT. Permite idempotência: retries com a mesma geração não
     * duplicam Acta/efeitos se o resultado já existir.
     */
    processingGeneration: integer("processing_generation").notNull().default(0),
    processingStartedAt: integer("processing_started_at", { mode: "timestamp" }),
    processingCompletedAt: integer("processing_completed_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    tenantIdx: index("reunioes_tenant_idx").on(t.tenantId),
    tenantStatusIdx: index("reunioes_tenant_status_idx").on(t.tenantId, t.status),
  }),
);

/**
 * Segmentos de áudio de uma única Reunião (MediaRecorder pode reiniciar sem nova reunião).
 *
 * Semântica de timestamps (MVP actual):
 * - startedAt / endedAt = momento em que o servidor persiste o segmento
 *   (aproximação de receção), NÃO o relógio exacto do MediaRecorder.
 * - clientStartedAt / clientEndedAt = opcionais, enviados pelo cliente quando disponíveis.
 *
 * status: o API actual só persiste segmentos `closed` (blob/upload concluído).
 * `open` existe no domínio in-memory / futuro upload progressivo servidor;
 * não fingir que o servidor mantém segmentos abertos durante a gravação.
 */
export const recordingSegments = sqliteTable(
  "recording_segments",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    reuniaoId: text("reuniao_id")
      .notNull()
      .references(() => reunioes.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    /** Receção no servidor (não clock exacto do browser). */
    startedAt: integer("started_at", { mode: "timestamp" }).notNull(),
    endedAt: integer("ended_at", { mode: "timestamp" }),
    /** Opcional: clock do cliente (ms epoch) se enviado. */
    clientStartedAt: integer("client_started_at", { mode: "timestamp" }),
    clientEndedAt: integer("client_ended_at", { mode: "timestamp" }),
    /** user_stop_segment | technical_interrupt | user_end_meeting */
    reasonEnded: text("reason_ended"),
    storagePath: text("storage_path"),
    byteSize: integer("byte_size").notNull().default(0),
    /** closed (persistido) | open (reservado — não usado no insert actual) */
    status: text("status").notNull().default("closed"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    reuniaoOrdinalUq: uniqueIndex("recording_segments_reuniao_ordinal_uq").on(
      t.reuniaoId,
      t.ordinal,
    ),
    reuniaoIdx: index("recording_segments_reuniao_idx").on(t.reuniaoId),
  }),
);

/**
 * AuditEvent genérico (Domain Kernel / ADR-009).
 * who/what/when/before/after/reason/source/request_id — invariante 10.
 * Usado por reuniões/gravação e pelo kernel (Membership create/revoke).
 */
export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id").notNull(),
    type: text("type").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    actorUserId: text("actor_user_id"),
    actorPersonId: text("actor_person_id"),
    payloadJson: text("payload_json"),
    beforeJson: text("before_json"),
    afterJson: text("after_json"),
    reason: text("reason"),
    source: text("source"),
    requestId: text("request_id"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    tenantCreatedIdx: index("audit_events_tenant_created_idx").on(t.tenantId, t.createdAt),
    entityIdx: index("audit_events_entity_idx").on(t.entityType, t.entityId),
    requestIdx: index("audit_events_request_id_idx").on(t.requestId),
  }),
);

/**
 * Domain Kernel v0.1 — Identidade (ADR-006 / ADR-031).
 * Role é extensível; conjunto inicial obrigatório inclui Fiscalizacao (não ConselhoFiscal).
 */
export const roles = sqliteTable("roles", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const persons = sqliteTable(
  "persons",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id"),
    name: text("name").notNull(),
    nif: text("nif"),
    email: text("email").notNull(),
    phone: text("phone"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    userIdUq: uniqueIndex("persons_user_id_uq").on(t.userId),
    emailUq: uniqueIndex("persons_email_uq").on(t.email),
    nifUq: uniqueIndex("persons_nif_uq").on(t.nif),
  }),
);

export const memberships = sqliteTable(
  "memberships",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    personId: text("person_id").notNull().references(() => persons.id),
    tenantId: text("tenant_id").notNull(),
    fracaoId: text("fracao_id"),
    roleCode: text("role_code").notNull().references(() => roles.code),
    scope: text("scope"),
    status: text("status").notNull().default("active"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    createdByPersonId: text("created_by_person_id"),
    revokedAt: integer("revoked_at", { mode: "timestamp" }),
    revokedByPersonId: text("revoked_by_person_id"),
  },
  (t) => ({
    personTenantStatusIdx: index("memberships_person_tenant_status_idx").on(
      t.personId,
      t.tenantId,
      t.status,
    ),
    tenantStatusIdx: index("memberships_tenant_status_idx").on(t.tenantId, t.status),
  }),
);

/**
 * DomainEvent bus (ADR-009) — append-only facts inside the tenant DB.
 */
export const domainEvents = sqliteTable(
  "domain_events",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id").notNull(),
    type: text("type").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    payloadJson: text("payload_json"),
    occurredAt: integer("occurred_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    correlationId: text("correlation_id"),
  },
  (t) => ({
    tenantOccurredIdx: index("domain_events_tenant_occurred_idx").on(t.tenantId, t.occurredAt),
    aggregateIdx: index("domain_events_aggregate_idx").on(t.aggregateType, t.aggregateId),
  }),
);

/**
 * Outbox / Job Queue (ADR-038) — idempotent async side-effects.
 */
export const outboxJobs = sqliteTable(
  "outbox_jobs",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id").notNull(),
    jobType: text("job_type").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payloadJson: text("payload_json").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(8),
    lastError: text("last_error"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    availableAt: integer("available_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    processedAt: integer("processed_at", { mode: "timestamp" }),
    correlationId: text("correlation_id"),
  },
  (t) => ({
    idempotencyUq: uniqueIndex("outbox_jobs_idempotency_uq").on(t.tenantId, t.idempotencyKey),
    pendingIdx: index("outbox_jobs_pending_idx").on(t.status, t.availableAt),
  }),
);

/**
 * Policy Engine skeleton — empty host for F2/F4/F5 policies.
 */
export const policies = sqliteTable(
  "policies",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id").notNull(),
    kind: text("kind").notNull(),
    code: text("code").notNull(),
    version: integer("version").notNull().default(1),
    bodyJson: text("body_json"),
    effectiveFrom: integer("effective_from", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    supersededBy: text("superseded_by"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    tenantKindCodeVersionUq: uniqueIndex("policies_tenant_kind_code_version_uq").on(
      t.tenantId,
      t.kind,
      t.code,
      t.version,
    ),
  }),
);

/**
 * Content-addressed uploads (F0 property 5) — repeated hash does not corrupt state.
 */
export const contentUploads = sqliteTable(
  "content_uploads",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id").notNull(),
    contentHash: text("content_hash").notNull(),
    filename: text("filename").notNull(),
    byteSize: integer("byte_size").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    tenantHashUq: uniqueIndex("content_uploads_tenant_hash_uq").on(t.tenantId, t.contentHash),
  }),
);

// --- F1: Ingestão + Constituição ---

export const ingestDocuments = sqliteTable(
  "ingest_documents",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id").notNull(),
    kind: text("kind").notNull(),
    contentUploadId: text("content_upload_id"),
    filename: text("filename").notNull(),
    contentHash: text("content_hash"),
    status: text("status").notNull().default("uploaded"),
    retentionClass: text("retention_class").notNull().default("legal_instrument"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    createdByPersonId: text("created_by_person_id"),
    processedAt: integer("processed_at", { mode: "timestamp" }),
    error: text("error"),
  },
  (t) => ({
    tenantStatusIdx: index("ingest_documents_tenant_status_idx").on(t.tenantId, t.status),
    tenantKindIdx: index("ingest_documents_tenant_kind_idx").on(t.tenantId, t.kind),
  }),
);

export const extractLines = sqliteTable(
  "extract_lines",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id").notNull(),
    documentId: text("document_id")
      .notNull()
      .references(() => ingestDocuments.id, { onDelete: "cascade" }),
    lineNo: integer("line_no").notNull(),
    kind: text("kind").notNull(),
    payloadJson: text("payload_json").notNull(),
    sourceExcerpt: text("source_excerpt").notNull(),
    confidence: real("confidence"),
    status: text("status").notNull().default("pending_review"),
    editedPayloadJson: text("edited_payload_json"),
    confirmedAt: integer("confirmed_at", { mode: "timestamp" }),
    confirmedByPersonId: text("confirmed_by_person_id"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    docLineUq: uniqueIndex("extract_lines_doc_line_uq").on(t.documentId, t.lineNo),
    tenantStatusIdx: index("extract_lines_tenant_status_idx").on(t.tenantId, t.status),
  }),
);

export const constitutionFracoes = sqliteTable(
  "constitution_fracoes",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id").notNull(),
    codigo: text("codigo").notNull(),
    tipo: text("tipo").notNull().default("fracao"),
    permilagem: integer("permilagem").notNull(),
    sourceDocumentId: text("source_document_id"),
    sourceLineId: text("source_line_id"),
    sourceExcerpt: text("source_excerpt"),
    status: text("status").notNull().default("confirmed"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    confirmedAt: integer("confirmed_at", { mode: "timestamp" }).notNull(),
    confirmedByPersonId: text("confirmed_by_person_id"),
  },
  (t) => ({
    tenantCodigoUq: uniqueIndex("constitution_fracoes_tenant_codigo_uq").on(t.tenantId, t.codigo),
    tenantIdx: index("constitution_fracoes_tenant_idx").on(t.tenantId),
  }),
);

export const ownerContactDrafts = sqliteTable(
  "owner_contact_drafts",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id").notNull(),
    documentId: text("document_id"),
    fracaoCodigo: text("fracao_codigo").notNull(),
    personName: text("person_name").notNull(),
    email: text("email"),
    phone: text("phone"),
    nif: text("nif"),
    sourceExcerpt: text("source_excerpt"),
    status: text("status").notNull().default("pending_review"),
    confirmedAt: integer("confirmed_at", { mode: "timestamp" }),
    confirmedByPersonId: text("confirmed_by_person_id"),
    personId: text("person_id"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    tenantStatusIdx: index("owner_contact_drafts_tenant_status_idx").on(t.tenantId, t.status),
  }),
);

export const condoIbanProofs = sqliteTable(
  "condo_iban_proofs",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id").notNull(),
    documentId: text("document_id").notNull(),
    iban: text("iban").notNull(),
    retentionClass: text("retention_class").notNull().default("personal_document"),
    status: text("status").notNull().default("registered"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    createdByPersonId: text("created_by_person_id"),
    purgedAt: integer("purged_at", { mode: "timestamp" }),
  },
  (t) => ({
    tenantIdx: index("condo_iban_proofs_tenant_idx").on(t.tenantId),
  }),
);

export const annualBudgets = sqliteTable(
  "annual_budgets",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id").notNull(),
    year: integer("year").notNull(),
    status: text("status").notNull().default("draft"),
    title: text("title").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    createdByPersonId: text("created_by_person_id"),
    approvedAt: integer("approved_at", { mode: "timestamp" }),
    approvedByPersonId: text("approved_by_person_id"),
  },
  (t) => ({
    tenantYearUq: uniqueIndex("annual_budgets_tenant_year_uq").on(t.tenantId, t.year),
  }),
);

export const annualBudgetLines = sqliteTable(
  "annual_budget_lines",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    budgetId: text("budget_id")
      .notNull()
      .references(() => annualBudgets.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id").notNull(),
    kind: text("kind").notNull(),
    label: text("label").notNull(),
    amountCents: integer("amount_cents").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    budgetIdx: index("annual_budget_lines_budget_idx").on(t.budgetId),
  }),
);

export const obligations = sqliteTable(
  "obligations",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id").notNull(),
    fracaoId: text("fracao_id").notNull(),
    budgetId: text("budget_id").notNull(),
    budgetLineId: text("budget_line_id").notNull(),
    kind: text("kind").notNull(),
    periodYear: integer("period_year").notNull(),
    amountCents: integer("amount_cents").notNull(),
    openAmountCents: integer("open_amount_cents").notNull(),
    status: text("status").notNull().default("open"),
    legalBasis: text("legal_basis"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    budgetLineFracaoUq: uniqueIndex("obligations_budget_line_fracao_uq").on(
      t.budgetLineId,
      t.fracaoId,
    ),
    tenantFracaoIdx: index("obligations_tenant_fracao_idx").on(t.tenantId, t.fracaoId),
    tenantStatusIdx: index("obligations_tenant_status_idx").on(t.tenantId, t.status),
  }),
);

// --- F2: Financeiro / Ledger ---

export const settlementPolicies = sqliteTable(
  "settlement_policies",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id").notNull(),
    code: text("code").notNull(),
    version: integer("version").notNull().default(1),
    status: text("status").notNull().default("active"),
    rulesJson: text("rules_json").notNull(),
    legalBasisJson: text("legal_basis_json"),
    effectiveFrom: integer("effective_from", { mode: "timestamp" }).notNull(),
    supersededBy: text("superseded_by"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    tenantCodeVersionUq: uniqueIndex("settlement_policies_tenant_code_version_uq").on(
      t.tenantId,
      t.code,
      t.version,
    ),
  }),
);

export const payments = sqliteTable(
  "payments",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id").notNull(),
    fracaoId: text("fracao_id"),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("EUR"),
    receivedAt: integer("received_at", { mode: "timestamp" }).notNull(),
    payerReference: text("payer_reference"),
    paymentMethod: text("payment_method").notNull(),
    allocationStatus: text("allocation_status").notNull().default("nao_alocado_pendente"),
    cashStatus: text("cash_status"),
    verificationMethod: text("verification_method"),
    registeredByPersonId: text("registered_by_person_id"),
    verifiedByPersonId: text("verified_by_person_id"),
    evidenceUploadId: text("evidence_upload_id"),
    bankMovementId: text("bank_movement_id"),
    depositedAt: integer("deposited_at", { mode: "timestamp" }),
    candidateSource: text("candidate_source"),
    candidateConfidence: real("candidate_confidence"),
    externalRef: text("external_ref"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    tenantStatusIdx: index("payments_tenant_status_idx").on(t.tenantId, t.allocationStatus),
    tenantFracaoIdx: index("payments_tenant_fracao_idx").on(t.tenantId, t.fracaoId),
    tenantCashIdx: index("payments_tenant_cash_idx").on(t.tenantId, t.cashStatus),
  }),
);

export const allocations = sqliteTable(
  "allocations",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id").notNull(),
    paymentId: text("payment_id")
      .notNull()
      .references(() => payments.id),
    obligationId: text("obligation_id").notNull(),
    amountCents: integer("amount_cents").notNull(),
    policyId: text("policy_id"),
    confidence: real("confidence"),
    approvedByPersonId: text("approved_by_person_id"),
    ledgerEntryId: text("ledger_entry_id"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    paymentIdx: index("allocations_payment_idx").on(t.paymentId),
    obligationIdx: index("allocations_obligation_idx").on(t.obligationId),
    tenantIdx: index("allocations_tenant_idx").on(t.tenantId),
  }),
);

export const ledgerEntries = sqliteTable(
  "ledger_entries",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id").notNull(),
    sequence: integer("sequence").notNull(),
    entryType: text("entry_type").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    payloadJson: text("payload_json").notNull(),
    previousHash: text("previous_hash").notNull(),
    entryHash: text("entry_hash").notNull(),
    algorithmVersion: text("algorithm_version").notNull().default("sha256-v1"),
    allocationId: text("allocation_id"),
    paymentId: text("payment_id"),
    obligationId: text("obligation_id"),
    amountCents: integer("amount_cents"),
    direction: text("direction"),
  },
  (t) => ({
    tenantSequenceUq: uniqueIndex("ledger_entries_tenant_sequence_uq").on(t.tenantId, t.sequence),
    tenantCreatedIdx: index("ledger_entries_tenant_created_idx").on(t.tenantId, t.createdAt),
    hashUq: uniqueIndex("ledger_entries_hash_uq").on(t.tenantId, t.entryHash),
  }),
);

export const accountingPeriods = sqliteTable(
  "accounting_periods",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id").notNull(),
    year: integer("year").notNull(),
    month: integer("month").notNull(),
    status: text("status").notNull().default("open"),
    closedAt: integer("closed_at", { mode: "timestamp" }),
    closedByPersonId: text("closed_by_person_id"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    tenantYmUq: uniqueIndex("accounting_periods_tenant_ym_uq").on(t.tenantId, t.year, t.month),
  }),
);

export const financialDocuments = sqliteTable(
  "financial_documents",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id").notNull(),
    fracaoId: text("fracao_id"),
    docType: text("doc_type").notNull(),
    periodLabel: text("period_label"),
    issuedAt: integer("issued_at", { mode: "timestamp" }).notNull(),
    dueAt: integer("due_at", { mode: "timestamp" }),
    amountCents: integer("amount_cents").notNull(),
    status: text("status").notNull().default("issued"),
    documentNumber: text("document_number"),
    generatedFromJson: text("generated_from_json").notNull(),
    sourcePaymentId: text("source_payment_id"),
    pdfUrl: text("pdf_url"),
    sentAt: integer("sent_at", { mode: "timestamp" }),
    deliveryStatus: text("delivery_status"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    tenantTypeIdx: index("financial_documents_tenant_type_idx").on(t.tenantId, t.docType),
    fracaoIdx: index("financial_documents_fracao_idx").on(t.fracaoId),
  }),
);

export const condoBankConnections = sqliteTable(
  "condo_bank_connections",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id").notNull(),
    provider: text("provider").notNull().default("enable_banking"),
    aspsp: text("aspsp"),
    accountIban: text("account_iban"),
    consentStatus: text("consent_status").notNull().default("pending"),
    consentValidUntil: integer("consent_valid_until", { mode: "timestamp" }),
    reauthorizationRequired: integer("reauthorization_required").notNull().default(0),
    authorizedByMembershipId: text("authorized_by_membership_id"),
    lastSyncAt: integer("last_sync_at", { mode: "timestamp" }),
    lastError: text("last_error"),
    lastReauthNoticeAt: integer("last_reauth_notice_at", { mode: "timestamp" }),
    revokedAt: integer("revoked_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    tenantIdx: index("condo_bank_connections_tenant_idx").on(t.tenantId),
  }),
);

export const tenantLedgerIntegrity = sqliteTable("tenant_ledger_integrity", {
  tenantId: text("tenant_id").primaryKey(),
  chainIntegrity: text("chain_integrity").notNull().default("ok"),
  lastValidatedAt: integer("last_validated_at", { mode: "timestamp" }),
  lastBreakSequence: integer("last_break_sequence"),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * Kernel F2 — movimento bancário tenant-scoped para cash deposit / bank_deposit.
 * Não substitui Fonte `bank_transactions` nem o ciclo Enable Banking.
 */
export const f2BankMovements = sqliteTable(
  "f2_bank_movements",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id").notNull(),
    amountCents: integer("amount_cents").notNull(),
    bookedAt: integer("booked_at", { mode: "timestamp" }).notNull(),
    description: text("description"),
    externalRef: text("external_ref"),
    counterpartyIban: text("counterparty_iban"),
    status: text("status").notNull().default("reconciled"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    tenantIdx: index("f2_bank_movements_tenant_idx").on(t.tenantId),
  }),
);

/**
 * Delivery attempts for notification jobs — observability without inbox guarantee (ADR-035).
 */
export const notificationDeliveries = sqliteTable(
  "notification_deliveries",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id").notNull(),
    channel: text("channel").notNull().default("email"),
    destination: text("destination").notNull(),
    template: text("template").notNull(),
    status: text("status").notNull(),
    providerMessageId: text("provider_message_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    idempotencyUq: uniqueIndex("notification_deliveries_idempotency_uq").on(
      t.tenantId,
      t.idempotencyKey,
    ),
  }),
);

// --- ATAS DE ASSEMBLEIA ---
export const atas = sqliteTable("atas", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  titulo: text("titulo").notNull(),
  dataReuniao: integer("data_reuniao", { mode: "timestamp" }).notNull(),
  status: text("status").notNull().default("rascunho"), // "rascunho" | "processando_audio" | "erro_audio" | "em_revisao" | "pdf_definitiva" | "aguardando_votos" | "aprovada" | "rejeitada"
  transcricaoRaw: text("transcricao_raw").notNull(),
  ataTexto: text("ata_texto").notNull(),
  /** Structured ata content (header, pontos, discussão, votos) as JSON — source of truth for editor/PDF. */
  conteudoJson: text("conteudo_json"),
  resumoDeliberacoes: text("resumo_deliberacoes"),
  // O áudio só deve ser disponibilizado ao portal dentro da janela de votação,
  // para depois ser removido (limpeza).
  audioPath: text("audio_path"), // nullable (após cleanup)
  audioAvailableUntil: integer("audio_available_until", { mode: "timestamp" }),
  pdfUrl: text("pdf_url"),
  pdfFinalizedAt: integer("pdf_finalized_at", { mode: "timestamp" }),
  approvalDeadlineAt: integer("approval_deadline_at", { mode: "timestamp" }),
  approvedAt: integer("approved_at", { mode: "timestamp" }),
  rejectedAt: integer("rejected_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// --- VOTOS DAS ATAS (condenominos) ---
export const ataVotes = sqliteTable("ata_votes", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  ataId: text("ata_id")
    .notNull()
    .references(() => atas.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  vote: text("vote").notNull(), // "approve" | "reject"
  votedAt: integer("voted_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// --- AVISOS ---
export const avisos = sqliteTable("avisos", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  titulo: text("titulo").notNull(),
  conteudo: text("conteudo").notNull(),
  tipo: text("tipo").default("geral"),
  destinatarios: text("destinatarios").default("todos"),
  enviado: integer("enviado").default(0),
  dataEnvio: integer("data_envio", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// --- DOCUMENTOS ---
export const documentos = sqliteTable("documentos", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  nome: text("nome").notNull(),
  tipo: text("tipo"),
  url: text("url").notNull(),
  tamanho: integer("tamanho"),
  descricao: text("descricao"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// --- AVISOS ENVIADOS (legado Turso — colunas reais, não ligadas a `avisos`) ---
export const avisosEnviados = sqliteTable("avisos_enviados", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  fracao: text("fracao").notNull(),
  proprietario: text("proprietario").notNull(),
  email: text("email").notNull(),
  assunto: text("assunto").notNull(),
  valorTotal: real("valor_total").notNull(),
  dividaCondominio: real("divida_condominio").default(0),
  dividaFundoReserva: real("divida_fundo_reserva").default(0),
  dividaMotorGaragem: real("divida_motor_garagem").default(0),
  dividaObras: real("divida_obras").default(0),
  dividaOutros: real("divida_outros").default(0),
  htmlBody: text("html_body"),
  enviadoEm: text("enviado_em").notNull(),
  estado: text("estado").notNull().default("enviado"),
  resendMessageId: text("resend_message_id"),
  erroMsg: text("erro_msg"),
});

// --- RECONCILIATION RULES (legado Turso) ---
export const reconciliationRules = sqliteTable("reconciliation_rules", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  triggerType: text("trigger_type").notNull(),
  triggerValue: text("trigger_value").notNull(),
  fracaoId: text("fracao_id"),
  categoria: text("categoria").notNull(),
  weight: integer("weight").notNull().default(1),
  usedCount: integer("used_count").notNull().default(1),
  createdAt: integer("created_at"),
  updatedAt: integer("updated_at"),
});

// --- BANK MOVEMENTS (legado Turso — distinto de bank_transactions) ---
export const bankMovements = sqliteTable("bank_movements", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  conta: text("conta").notNull().default("condominio"),
  externalId: text("external_id"),
  dataOperacao: text("data_operacao").notNull(),
  dataValor: text("data_valor"),
  descritivo: text("descritivo").notNull(),
  montante: real("montante").notNull(),
  saldo: real("saldo"),
  tipo: text("tipo"),
  nomeOrdenante: text("nome_ordenante"),
  ibanOrigem: text("iban_origem"),
  referencia: text("referencia"),
  pdfPath: text("pdf_path"),
  pdfText: text("pdf_text"),
  pdfNomePagador: text("pdf_nome_pagador"),
  pdfIbanPagador: text("pdf_iban_pagador"),
  pdfReferencia: text("pdf_referencia"),
  fracaoId: text("fracao_id"),
  categoria: text("categoria"),
  subcategoria: text("subcategoria"),
  confidence: integer("confidence").default(0),
  confidenceLevel: text("confidence_level"),
  categoriaSource: text("categoria_source"),
  notaCategorizacao: text("nota_categorizacao"),
  allocations: text("allocations"),
  status: text("status").notNull().default("pendente"),
  manualOverride: integer("manual_override").default(false),
  confirmedBy: text("confirmed_by"),
  confirmedAt: integer("confirmed_at"),
  createdAt: integer("created_at"),
  updatedAt: integer("updated_at"),
});

// --- IMPUTAÇÃO AUDIT LOG (legado Turso) ---
export const imputacaoAuditLog = sqliteTable("imputacao_audit_log", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  movementId: text("movement_id"),
  quotaId: text("quota_id"),
  fracaoId: text("fracao_id"),
  tipo: text("tipo").notNull(),
  fromCategoria: text("from_categoria"),
  toCategoria: text("to_categoria"),
  fromFracaoId: text("from_fracao_id"),
  toFracaoId: text("to_fracao_id"),
  valor: real("valor"),
  motivo: text("motivo"),
  utilizador: text("utilizador"),
  createdAt: integer("created_at"),
});

// --- SALDOS DE REFERÊNCIA (legado Turso) ---
export const saldosReferencia = sqliteTable("saldos_referencia", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  fracao: text("fracao").notNull(),
  rubrica: text("rubrica").notNull().default("condominio"),
  valorDivida: real("valor_divida").notNull().default(0),
  dataReferencia: text("data_referencia").notNull(),
  fonte: text("fonte").notNull().default("excel_2026"),
  notas: text("notas"),
  createdAt: integer("created_at"),
});

// --- PEDIDOS / TICKETS (portal ↔ admin, com triagem LLM) ---
export const tickets = sqliteTable("tickets", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  fracaoId: text("fracao_id")
    .notNull()
    .references(() => fracoes.id),
  createdByUserId: text("created_by_user_id")
    .notNull()
    .references(() => user.id),
  titulo: text("titulo").notNull(),
  descricao: text("descricao").notNull(),
  /** manutencao | ruido | financeiro | juridico | administrativo | outro */
  categoria: text("categoria").notNull().default("outro"),
  /** baixa | normal | alta | urgente */
  urgencia: text("urgencia").notNull().default("normal"),
  /** aberto | em_curso | aguarda_condomino | pendente_aprovacao | resolvido | cancelado */
  status: text("status").notNull().default("aberto"),
  /** portal | email */
  origem: text("origem").notNull().default("portal"),
  llmCategoria: text("llm_categoria"),
  llmUrgencia: text("llm_urgencia"),
  llmResumo: text("llm_resumo"),
  llmSugestaoResposta: text("llm_sugestao_resposta"),
  /** Notas internas geradas pela LLM (só admin) */
  llmNotasInternas: text("llm_notas_internas"),
  /** Último feedback: positive | negative | null */
  llmFeedbackRating: text("llm_feedback_rating"),
  llmFeedbackAt: integer("llm_feedback_at", { mode: "timestamp" }),
  resolvedAt: integer("resolved_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const ticketMessages = sqliteTable("ticket_messages", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  ticketId: text("ticket_id")
    .notNull()
    .references(() => tickets.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id),
  /** admin | condomino | system */
  authorRole: text("author_role").notNull(),
  body: text("body").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const ticketAttachments = sqliteTable("ticket_attachments", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  ticketId: text("ticket_id")
    .notNull()
    .references(() => tickets.id, { onDelete: "cascade" }),
  messageId: text("message_id").references(() => ticketMessages.id, { onDelete: "set null" }),
  uploadedByUserId: text("uploaded_by_user_id")
    .notNull()
    .references(() => user.id),
  /** image | video */
  kind: text("kind").notNull(),
  mimeType: text("mime_type").notNull(),
  originalName: text("original_name").notNull(),
  filename: text("filename").notNull(),
  sizeBytes: integer("size_bytes").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/** Feedback humano sobre triagem/sugestão LLM — memória de aprendizagem por área */
export const ticketLlmFeedback = sqliteTable("ticket_llm_feedback", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  ticketId: text("ticket_id")
    .notNull()
    .references(() => tickets.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id),
  /** positive | negative */
  rating: text("rating").notNull(),
  /** sugestao | categoria | urgencia | geral */
  target: text("target").notNull().default("geral"),
  comment: text("comment"),
  /** Valores correctos quando o admin corrige (aprendizagem) */
  correctedCategoria: text("corrected_categoria"),
  correctedUrgencia: text("corrected_urgencia"),
  correctedResposta: text("corrected_resposta"),
  /** Snapshot do que a LLM tinha proposto */
  llmCategoria: text("llm_categoria"),
  llmUrgencia: text("llm_urgencia"),
  llmSugestaoResposta: text("llm_sugestao_resposta"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// --- EMAIL INBOX (urbanizacaofonte@gmail.com → triagem LLM → resposta humana) ---
export const emailInbox = sqliteTable("email_inbox", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  /** ID único do provedor (Gmail Message-ID / IMAP uid) para dedupe */
  externalId: text("external_id").notNull().unique(),
  fromEmail: text("from_email").notNull(),
  fromName: text("from_name"),
  toEmail: text("to_email").notNull().default("urbanizacaofonte@gmail.com"),
  subject: text("subject").notNull().default(""),
  bodyText: text("body_text"),
  bodyHtml: text("body_html"),
  /** Marcador Gmail (INBOX ou label custom, ex. Elevadores) */
  gmailLabel: text("gmail_label"),
  receivedAt: integer("received_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  fracaoId: text("fracao_id").references(() => fracoes.id),
  ticketId: text("ticket_id").references(() => tickets.id),
  /** manutencao | ruido | financeiro | juridico | administrativo | fornecedor | spam | outro */
  categoria: text("categoria").notNull().default("outro"),
  urgencia: text("urgencia").notNull().default("normal"),
  llmResumo: text("llm_resumo"),
  llmSugestaoResposta: text("llm_sugestao_resposta"),
  llmNotasInternas: text("llm_notas_internas"),
  /** novo | em_analise | respondido | convertido_pedido | ignorado | spam | processado */
  status: text("status").notNull().default("novo"),
  processedAt: integer("processed_at", { mode: "timestamp" }),
  replyBody: text("reply_body"),
  repliedAt: integer("replied_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/** Chaves de idempotência HTTP (retries sem duplicar emails / pagamentos). */
export const idempotencyKeys = sqliteTable("idempotency_keys", {
  id: text("id").primaryKey(), // scope::key
  scope: text("scope").notNull(),
  key: text("key").notNull(),
  status: text("status").notNull().default("pending"), // pending | completed
  responseStatus: integer("response_status"),
  responseBody: text("response_body"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  completedAt: integer("completed_at", { mode: "timestamp" }),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
});
