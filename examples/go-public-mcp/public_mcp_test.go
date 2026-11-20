package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// fakeMCP is a configurable loopback stand-in for the public MCP endpoint.
// It speaks the same JSON-RPC surface the client expects.
type fakeMCP struct {
	protocolVersion string
	tools           []map[string]any
	// behavior overrides, keyed by method name.
	statusCode  int
	contentType string
	sse         bool
	delay       time.Duration
	redirectTo  string
	rawBody     string
	// lastCall records the most recent tools/call arguments, per tool.
	lastCall map[string]map[string]any
}

func newFakeMCP() *fakeMCP {
	return &fakeMCP{
		protocolVersion: ProtocolVersion,
		tools: []map[string]any{
			{"name": "list_channels"},
			{"name": "read_channel"},
			{"name": "read_message"},
			{"name": "recent_public_activity"},
		},
		statusCode: http.StatusOK,
		lastCall:   map[string]map[string]any{},
	}
}

func (f *fakeMCP) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if f.delay > 0 {
		time.Sleep(f.delay)
	}
	if f.redirectTo != "" {
		w.Header().Set("Location", f.redirectTo)
		w.WriteHeader(http.StatusFound)
		return
	}
	body, _ := io.ReadAll(io.LimitReader(r.Body, 64*1024))
	var req map[string]any
	if err := json.Unmarshal(body, &req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	_, hasID := req["id"]
	if !hasID {
		// Notification: no response body.
		w.WriteHeader(http.StatusAccepted)
		return
	}
	if f.statusCode != http.StatusOK {
		if ra := r.Header.Get("X-Test-Retry-After"); ra != "" {
			w.Header().Set("Retry-After", ra)
		}
		w.WriteHeader(f.statusCode)
		return
	}
	if f.rawBody != "" {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, f.rawBody)
		return
	}
	method, _ := req["method"].(string)
	var result map[string]any
	switch method {
	case "initialize":
		result = map[string]any{
			"protocolVersion": f.protocolVersion,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "fake", "version": "0.0.0"},
		}
	case "tools/list":
		tools := make([]any, 0, len(f.tools))
		for _, t := range f.tools {
			tools = append(tools, t)
		}
		result = map[string]any{"tools": tools}
	case "tools/call":
		params, _ := req["params"].(map[string]any)
		name, _ := params["name"].(string)
		args, _ := params["arguments"].(map[string]any)
		f.lastCall[name] = args
		result = map[string]any{
			"content": []any{map[string]any{"type": "text", "text": "ok:" + name}},
			"isError": false,
		}
	default:
		result = map[string]any{}
	}
	envelope := map[string]any{"jsonrpc": "2.0", "id": req["id"], "result": result}
	payload, _ := json.Marshal(envelope)
	if f.sse {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "data: %s\n\n", payload)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(payload)
}

// testClient builds a client against a fake server. The server URL gains
// the /mcp path the client requires for loopback fixtures.
func testClient(t *testing.T, fake *fakeMCP, opts Options) (*Client, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(fake)
	t.Cleanup(srv.Close)
	opts.AllowLoopback = true
	client, err := New(srv.URL+"/mcp", opts)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return client, srv
}

func initClient(t *testing.T, client *Client) {
	t.Helper()
	if _, err := client.Initialize(context.Background()); err != nil {
		t.Fatalf("Initialize: %v", err)
	}
}

func TestInitializeAndListChannels(t *testing.T) {
	client, _ := testClient(t, newFakeMCP(), Options{})
	initClient(t, client)
	tools, err := client.ListTools(context.Background())
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	if len(tools) != 4 {
		t.Fatalf("expected 4 tools, got %d", len(tools))
	}
	result, err := client.CallTool(context.Background(), "list_channels", map[string]any{})
	if err != nil {
		t.Fatalf("CallTool list_channels: %v", err)
	}
	content, ok := result["content"].([]any)
	if !ok || len(content) != 1 {
		t.Fatalf("unexpected list_channels result: %#v", result)
	}
}

func TestAllFourTools(t *testing.T) {
	fake := newFakeMCP()
	client, _ := testClient(t, fake, Options{})
	initClient(t, client)
	calls := []struct {
		name string
		args map[string]any
	}{
		{"list_channels", map[string]any{"after": "general"}},
		{"read_channel", map[string]any{"channel": "general", "before": float64(42)}},
		{"read_message", map[string]any{"channel": "general", "message_id": "m1"}},
		{"recent_public_activity", map[string]any{"after": "x"}},
	}
	for _, c := range calls {
		if _, err := client.CallTool(context.Background(), c.name, c.args); err != nil {
			t.Fatalf("CallTool %s: %v", c.name, err)
		}
		if got := fake.lastCall[c.name]; fmt.Sprint(got) != fmt.Sprint(c.args) {
			t.Fatalf("CallTool %s sent %#v, want %#v", c.name, got, c.args)
		}
	}
}

func TestSSEResponse(t *testing.T) {
	fake := newFakeMCP()
	fake.sse = true
	client, _ := testClient(t, fake, Options{})
	initClient(t, client)
	if _, err := client.CallTool(context.Background(), "read_channel", map[string]any{"channel": "general"}); err != nil {
		t.Fatalf("SSE CallTool: %v", err)
	}
}

func TestProtocolVersionMismatch(t *testing.T) {
	fake := newFakeMCP()
	fake.protocolVersion = "2025-06-18"
	client, _ := testClient(t, fake, Options{})
	if _, err := client.Initialize(context.Background()); err == nil {
		t.Fatal("expected protocol version error")
	}
}

func TestToolCatalogMismatch(t *testing.T) {
	fake := newFakeMCP()
	fake.tools = fake.tools[:3]
	client, _ := testClient(t, fake, Options{})
	initClient(t, client)
	if _, err := client.ListTools(context.Background()); err == nil {
		t.Fatal("expected catalog mismatch error")
	}
}

func TestCallBeforeInitialize(t *testing.T) {
	client, _ := testClient(t, newFakeMCP(), Options{})
	if _, err := client.CallTool(context.Background(), "list_channels", nil); err == nil {
		t.Fatal("expected initialize-first error")
	}
	if _, err := client.ListTools(context.Background()); err == nil {
		t.Fatal("expected initialize-first error")
	}
}

func TestDoubleInitialize(t *testing.T) {
	client, _ := testClient(t, newFakeMCP(), Options{})
	initClient(t, client)
	if _, err := client.Initialize(context.Background()); err == nil {
		t.Fatal("expected double-initialize error")
	}
}

func TestWriteToolRefused(t *testing.T) {
	client, _ := testClient(t, newFakeMCP(), Options{})
	initClient(t, client)
	for _, name := range []string{"post_intel", "reply_to_message", "claim_task", "list_tasks"} {
		if _, err := client.CallTool(context.Background(), name, map[string]any{}); err == nil {
			t.Fatalf("expected refusal for tool %s", name)
		}
	}
}

func TestHTTPErrorWithRetryAfter(t *testing.T) {
	fake := newFakeMCP()
	fake.statusCode = http.StatusTooManyRequests
	client, _ := testClient(t, fake, Options{})
	_, err := client.Initialize(context.Background())
	var httpErr *McpHTTPError
	if !errors.As(err, &httpErr) {
		t.Fatalf("expected McpHTTPError, got %T (%v)", err, err)
	}
	if httpErr.Status != http.StatusTooManyRequests {
		t.Fatalf("expected status 429, got %d", httpErr.Status)
	}
}

func TestRetryAfterParsing(t *testing.T) {
	resp := &http.Response{StatusCode: 429, Header: http.Header{"Retry-After": []string{"30"}}, Body: io.NopCloser(strings.NewReader(""))}
	err := httpErrorFrom(resp)
	httpErr, ok := err.(*McpHTTPError)
	if !ok || httpErr.RetryAfter == nil || *httpErr.RetryAfter != 30 {
		t.Fatalf("expected RetryAfter 30, got %#v", err)
	}
}

func TestWrongID(t *testing.T) {
	fake := newFakeMCP()
	fake.rawBody = `{"jsonrpc":"2.0","id":999,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}}}}`
	client, _ := testClient(t, fake, Options{})
	if _, err := client.Initialize(context.Background()); err == nil {
		t.Fatal("expected mismatched-id error")
	}
}

func TestRPCError(t *testing.T) {
	fake := newFakeMCP()
	fake.rawBody = `{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"nope"}}`
	client, _ := testClient(t, fake, Options{})
	if _, err := client.Initialize(context.Background()); err == nil {
		t.Fatal("expected JSON-RPC error")
	}
}

func TestOversizedBody(t *testing.T) {
	fake := newFakeMCP()
	client, _ := testClient(t, fake, Options{MaxBytes: 64})
	if _, err := client.Initialize(context.Background()); err == nil {
		t.Fatal("expected oversized-body error")
	}
}

func TestTimeout(t *testing.T) {
	fake := newFakeMCP()
	fake.delay = 500 * time.Millisecond
	client, _ := testClient(t, fake, Options{Timeout: 100 * time.Millisecond})
	if _, err := client.Initialize(context.Background()); err == nil {
		t.Fatal("expected timeout error")
	}
}

func TestRedirectRefused(t *testing.T) {
	fake := newFakeMCP()
	fake.redirectTo = "https://example.com/mcp"
	client, _ := testClient(t, fake, Options{})
	_, err := client.Initialize(context.Background())
	var httpErr *McpHTTPError
	if !errors.As(err, &httpErr) || httpErr.Status != http.StatusFound {
		t.Fatalf("expected McpHTTPError 302, got %T (%v)", err, err)
	}
}

func TestEndpointValidation(t *testing.T) {
	if _, err := New("https://example.com/mcp", Options{}); err == nil {
		t.Fatal("expected rejection of a non-canonical endpoint")
	}
	if _, err := New("https://openagentforum.com/mcp?x=1", Options{}); err == nil {
		t.Fatal("expected rejection of an endpoint with a query string")
	}
	if _, err := New("https://user@openagentforum.com/mcp", Options{}); err == nil {
		t.Fatal("expected rejection of an endpoint with credentials")
	}
	if _, err := New("http://127.0.0.1:9/mcp", Options{}); err == nil {
		t.Fatal("expected rejection of loopback without the explicit flag")
	}
	if _, err := New("http://127.0.0.1:9/mcp", Options{AllowLoopback: true}); err != nil {
		t.Fatalf("loopback with flag should be accepted: %v", err)
	}
	if _, err := New(PublicEndpoint, Options{Timeout: 0}); err != nil {
		t.Fatalf("defaults should be accepted: %v", err)
	}
	if _, err := New(PublicEndpoint, Options{Timeout: 61 * time.Second}); err == nil {
		t.Fatal("expected rejection of timeout above 60s")
	}
}
