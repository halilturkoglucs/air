package fixture;

@RestController
class Orders {
    @PostMapping("/orders")
    @Transactional
    Object place(Object request) {
        return request;
    }

    @KafkaListener(topics = "orders.placed")
    void consume(String message) {
    }
}
