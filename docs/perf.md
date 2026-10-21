# Performance Benchmarks

## Baseline (v2 Signed Join)

Reference from earlier tests: 50 -> 0.83 s, 100 -> 4.5 s, 200 -> 20.8 s.

Benchmark results (`tools/bench.py`):

```json
[
  {
    "clients": 50,
    "joined": 50,
    "join_time_s": 0.337,
    "fanout_delivered": 50,
    "latency_min_ms": 4.67,
    "latency_avg_ms": 9.68,
    "latency_max_ms": 14.93
  },
  {
    "clients": 100,
    "joined": 100,
    "join_time_s": 1.514,
    "fanout_delivered": 0,
    "latency_min_ms": null,
    "latency_avg_ms": null,
    "latency_max_ms": null
  },
  {
    "clients": 200,
    "joined": 200,
    "join_time_s": 9.321,
    "fanout_delivered": 0,
    "latency_min_ms": null,
    "latency_avg_ms": null,
    "latency_max_ms": null
  }
]
```

### Summary Numbers
- 50 clients: 0.337 s join time
- 100 clients: 1.514 s join time
- 200 clients: 9.321 s join time
