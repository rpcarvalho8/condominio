# 01 — Constituição do Condomínio

> "Antes de código, há lei."

## Princípio

Cada condomínio é uma entidade legal governada por:

1. **Código Civil** (arts. 1414.º–1438.º-A) — propriedade horizontal
2. **DL 268/94** — regulamento da administração de condomínios
3. **Regulamento Interno** — aprovado em assembleia, específico do prédio

A constituição é o conjunto de **dados imutáveis** (ou raramente mutáveis) que definem o condomínio como entidade:

## Dados Fundacionais (input do tenant)

| Dado | Fonte | Mutabilidade |
|------|-------|-------------|
| Morada / localização | Certidão predial | Imutável |
| Frações (A–Z, AA–AZ…) | Propriedade horizontal | Imutável |
| Permilagens por fração | Escritura / Regulamento | Raro (assembleia 2/3) |
| Regulamento Interno (PDF) | Assembleia | Alterável por maioria qualificada |
| IBANs do condomínio | Administrador | Alterável |
| Contactos dos proprietários | Administrador / portal | Alterável |
| NIF do condomínio | Finanças | Imutável |

## Como entra no sistema

1. Admin regista condomínio → insere morada, NIF, IBAN
2. Faz upload do **PDF do Regulamento Interno**
   - LLM (especialista Jurídico) extrai: permilagens, regras de utilização, penalizações
   - Resultado fica como **dados estruturados** + PDF original arquivado
3. Admin confirma/corrige permilagens extraídas
4. Frações ficam criadas automaticamente a partir das permilagens

## Relação com a Orquestra

A Constituição alimenta a **Memória Única do Prédio** — é a camada de factos que todas as especialidades LLM consultam mas nenhuma altera directamente.

```
┌─────────────────────────────────┐
│         CONSTITUIÇÃO            │
│  ┌───────┐ ┌────────────────┐  │
│  │ Leis  │ │ Reg. Interno   │  │
│  │ (ref) │ │ (dados parsed) │  │
│  └───────┘ └────────────────┘  │
│  ┌──────────┐ ┌─────────────┐  │
│  │Frações   │ │ Permilagens │  │
│  │A..AJ     │ │ ‰ por fração│  │
│  └──────────┘ └─────────────┘  │
│  ┌──────────┐ ┌─────────────┐  │
│  │ IBANs    │ │ Contactos   │  │
│  └──────────┘ └─────────────┘  │
└─────────────┬───────────────────┘
              │ read-only
              ▼
      Memória Única do Prédio
```
