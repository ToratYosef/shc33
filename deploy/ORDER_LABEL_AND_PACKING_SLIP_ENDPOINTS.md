# Order label + packing slip endpoints

Base API URL:

- `https://api.secondhandcell.com`

Per-order endpoints:

- Packing slip PDF:
  - `GET /packing-slip/:orderId`
  - Example: `https://api.secondhandcell.com/packing-slip/SHC-12345`

- Print bundle:
  - Shipping kit orders: outbound label + inbound label + packing slip (in this exact order)
  - Non-kit/email-label orders: single return label + packing slip
  - `GET /print-bundle/:orderId`
  - Example: `https://api.secondhandcell.com/print-bundle/SHC-12345`

- Generate/re-generate labels:
  - `POST /generate-label/:orderId`
  - Example: `https://api.secondhandcell.com/generate-label/SHC-12345`

- Order details (for checking stored label fields):
  - `GET /orders/:orderId`
  - Example: `https://api.secondhandcell.com/orders/SHC-12345`
