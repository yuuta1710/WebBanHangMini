async function testOrderCode() {
    console.log("🛒 Gửi yêu cầu đặt hàng thử nghiệm sinh mã bảo mật...");
    try {
        const response = await fetch('http://localhost:5000/api/orders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                customer_name: "Khách hàng siêu cấp",
                items: [{ "product_id": 1, "quantity": 1 }]
            })
        });

        const data = await response.json();
        if (response.ok) {
            console.log("✅ ĐẶT HÀNG THÀNH CÔNG!");
            console.log("📦 Dữ liệu đơn hàng nhận được từ Backend:");
            console.log(JSON.stringify(data.order, null, 2));
        } else {
            console.log("⚠️ Backend báo lỗi:", data.message);
        }
    } catch (error) {
        console.error("❌ Lỗi kết nối:", error.message);
    }
}

testOrderCode();