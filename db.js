const { Pool } = require('pg');
require('dotenv').config();

// Kiểm tra môi trường chạy hiện tại để kích hoạt SSL động thông minh
const isProduction = process.env.NODE_ENV === 'production';

// Khởi tạo Pool kết nối với chuỗi DATABASE_URL từ file .env
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // BẮT BUỘC BẬT SSL: Do Render yêu cầu tất cả kết nối (kể cả từ máy local) phải qua SSL/TLS
  ssl: {
    rejectUnauthorized: false
  }
});

// Hàm kiểm tra kết nối khi khởi động Server
const testConnection = async () => {
  try {
    const client = await pool.connect();
    console.log(isProduction ? '✅ Kết nối thành công tới PostgreSQL trên Render Cloud!' : '✅ Kết nối thành công tới PostgreSQL dưới máy Local!');
    
    // Thử lấy thời gian hiện tại của Database để chắc chắn thông suốt
    const res = await client.query('SELECT NOW()');
    console.log(`🕒 Giờ hệ thống Database: ${res.rows[0].now}`);
    
    client.release(); // Giải phóng kết nối lại vào Pool
  } catch (err) {
    console.error('❌ Lỗi kết nối Database thất bại:', err.message);
  }
};

testConnection();

const initializeDatabase = async () => {
  const createTablesQuery = `
    -- 1. Tạo bảng sản phẩm nếu chưa tồn tại
    CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        price INT NOT NULL,
        image_url TEXT,
        description TEXT,
        stock_quantity INT NOT NULL DEFAULT 0
    );

    -- 2. Tạo bảng đơn hàng giả lập nếu chưa tồn tại
    CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        customer_name VARCHAR(255) NOT NULL,
        total_price INT NOT NULL,
        items JSONB NOT NULL, -- Sử dụng JSONB để lưu mảng danh sách sản phẩm mua cực kỳ tiện lợi
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;

  try {
    // 1. Chạy lệnh tạo bảng
    await pool.query(createTablesQuery);
    console.log('📦 Cấu trúc các bảng (products, orders) đã sẵn sàng.');

    // 2. Tự động SEED dữ liệu mẫu nếu bảng products chưa có hàng nào
    const productCheck = await pool.query('SELECT COUNT(*) FROM products');
    if (parseInt(productCheck.rows[0].count) === 0) {
      console.log('🌱 Bảng sản phẩm đang trống. Tiến hành nạp dữ liệu mẫu...');
      
      const seedQuery = `
        INSERT INTO products (name, price, image_url, description, stock_quantity) VALUES
        ('Laptop Asus ROG Gaming', 24990000, 'https://picsum.photos/id/1/200/200', 'Laptop gaming hiệu năng cao', 10),
        ('Chuột Không Dây Logitech G304', 850000, 'https://picsum.photos/id/2/200/200', 'Chuột gaming quốc dân siêu nhạy', 15),
        ('Bàn Phím Cơ AKKO 3068', 1590000, 'https://picsum.photos/id/3/200/200', 'Bàn phím cơ nhỏ gọn, gõ êm', 5);
      `;
      
      await pool.query(seedQuery);
      console.log('🚀 Đã seed thành công 3 sản phẩm mẫu vào database!');
    }
  } catch (err) {
    console.error('❌ Lỗi khởi tạo cấu trúc dữ liệu:', err.message);
  }
};

// Kích hoạt hàm khởi tạo
initializeDatabase();

module.exports = pool;